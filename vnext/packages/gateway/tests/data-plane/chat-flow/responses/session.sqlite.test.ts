import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { createBunResponsesStore } from "@vibe-llm/platform-bun/src/responses-store-factory.ts"
import { initRepo } from "../../../../src/repo/index.ts"
import { initResponsesStore } from "../../../../src/data-plane/runtime/responses-store.ts"
import { setupTestPlatform } from "../../../_setup-platform.ts"
import type { ApiKeyId, UserId, UpstreamId } from "../../../../src/repo/branded-ids.ts"
import { authorizeResponsesSession, createResponsesSession, type ResponsesSessionTransport, type ResponsesSessionClock } from "../../../../src/data-plane/chat-flow/responses/session.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
const keyId = "key" as ApiKeyId
const owner = "owner" as UserId
const create = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "response.create", model: "model", input: "hello", stream: true, store: false, ...extra })
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000
  while (!predicate()) { if (Date.now() > deadline) throw new Error("fixture deadline"); await Bun.sleep(2) }
}
async function fixture(endpoint: "responses" | "chat_completions" = "responses") {
  setupTestPlatform().db.close()
  const dir = mkdtempSync(join(tmpdir(), "c12-session-"))
  const db = new Database(join(dir, "db.sqlite"))
  const repo = new BunSqliteRepo(db)
  const external = new Database(join(dir, "db.sqlite"))
  initRepo(repo)
  const store = createBunResponsesStore(new BunSqliteDatabase(db))
  initResponsesStore(store)
  const calls: Record<string, unknown>[] = []
  let hold = false
  let fail = false
  let aborted = false
  let extraEvents: unknown[] = []
  const release = Promise.withResolvers<void>()
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>
    calls.push(body)
    if (hold) {
      request.signal.addEventListener("abort", () => { aborted = true })
      await release.promise
    }
    if (endpoint === "chat_completions") return new Response([
      { id: "chat", model: "model", choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: null }] },
      { id: "chat", model: "model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    const response = { id: `resp_${calls.length}`, object: "response", model: "model", status: fail ? "failed" : "completed", output: [], error: fail ? { code: "invalid_prompt", message: "fixture failure" } : null, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
    return new Response([
      { type: "response.created", response: { ...response, status: "in_progress" } },
      ...extraEvents,
      { type: fail ? "response.failed" : "response.completed", response },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  } })
  await repo.users.create({ id: owner, name: "Fixture", disabled: false, createdAt: "now" })
  await repo.apiKeys.save({ id: keyId, key: "sk_c12_local_fixture", name: "fixture", ownerId: owner, createdAt: "now", dumpRetentionSeconds: null, modelMappingsEnabled: false, modelMappings: [] })
  await repo.upstreams.save({ id: "up" as UpstreamId, ownerId: owner, provider: "custom", name: "fixture", enabled: true, sortOrder: 0, config: { name: "fixture", baseUrl: upstream.url.toString().replace(/\/$/, ""), authStyle: "none", endpoints: [endpoint], models: ["model", "other"] }, state: null, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "direct_fetch" }], createdAt: "now", updatedAt: "now" })
  const sessions: ReturnType<typeof createResponsesSession>[] = []
  const pending = new Set<Promise<unknown>>()
  const background = { waitUntil(p: Promise<unknown>) { pending.add(p); void p.finally(() => pending.delete(p)).catch(() => {}) } }
  async function connect(transportOverrides: Partial<ResponsesSessionTransport> = {}, credential = "sk_c12_local_fixture", clock?: ResponsesSessionClock) {
    const request = new Request("http://fixture/v1/responses", { headers: { authorization: `Bearer ${credential}` } })
    const authorization = await authorizeResponsesSession(request)
    const events: Record<string, unknown>[] = []
    const closes: number[] = []
    const transport: ResponsesSessionTransport = { pressure: { kind: "unobservable" }, sendText(text) { events.push(JSON.parse(text)); return "accepted" }, close(code) { closes.push(code) }, ...transportOverrides }
    const session = createResponsesSession({ authorization, request: { url: request.url, headers: request.headers }, transport, background, clock })
    sessions.push(session)
    return { session, events, closes }
  }
  cleanup.push(async () => { release.resolve(); await Promise.all(sessions.map(s => s.close())); await Promise.allSettled([...pending]); await upstream.stop(true); external.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { repo, external, store, connect, calls, pending, extraEvents: (events: unknown[]) => { extraEvents = events }, hold: () => { hold = true }, fail: (value = true) => { fail = value }, release: () => release.resolve(), aborted: () => aborted }
}

for (const endpoint of ["responses", "chat_completions"] as const) {
  test(`full warmup state chains through real ${endpoint} inference with zero warmup calls`, async () => {
    const f = await fixture(endpoint)
    const { session, events } = await f.connect()
    const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }]
    session.receiveText(create({ generate: false, instructions: "remember", tools, reasoning: { effort: "low" } }))
    await until(() => events.some(e => e.type === "response.completed"))
    expect(events.map(e => e.type)).toEqual(["response.created", "response.completed"])
    expect(f.calls).toHaveLength(0)
    const id = (events[1]?.response as { id: string }).id
    expect((events[0]?.response as { id: string }).id).toBe(id)
    session.receiveText(create({ previous_response_id: id, input: [] }))
    await until(() => events.filter(e => e.type === "response.completed").length === 2)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).not.toHaveProperty("type")
    expect(f.calls[0]).not.toHaveProperty("generate")
    expect(f.calls[0]).not.toHaveProperty("previous_response_id")
    const wire = JSON.stringify(f.calls[0])
    expect(wire).toContain("remember")
    expect(wire).toContain("hello")
    expect(wire).toContain("lookup")
    expect(await f.store.load(id, keyId)).toBeNull()
    const other = await f.connect()
    other.session.receiveText(create({ previous_response_id: id, input: [] }))
    await until(() => other.events.length > 0)
    expect(other.events[0]).toMatchObject({ type: "error", status: 400, error: { code: "previous_response_not_found" } })
  })
}

test("warmup rejects store:true and unsupported protocol fields without inference", async () => {
  const f = await fixture()
  const { session, events } = await f.connect()
  for (const extension of [{ generate: false, store: true }, { stream_id: "s" }, { fork: true }, { background: true }, { stream: false }, { event_id: "e" }]) session.receiveText(create(extension))
  await until(() => events.length === 6)
  expect(events.every(e => e.type === "error" && e.status === 400)).toBe(true)
  expect(f.calls).toHaveLength(0)
})

test("external owner disable and key deletion revoke existing socket before next inference", async () => {
  for (const sql of ["UPDATE users SET disabled = 1 WHERE id = 'owner'", "DELETE FROM api_keys WHERE id = 'key'"]) {
    const f = await fixture()
    const { session, events } = await f.connect()
    session.receiveText(create({ generate: false }))
    await until(() => events.some(e => e.type === "response.completed"))
    f.external.exec(sql)
    session.receiveText(create())
    await until(() => events.some(e => e.type === "error"))
    expect(events.at(-1)).toMatchObject({ status: 401 })
    expect(f.calls).toHaveLength(0)
  }
})

test("overlap and malformed messages preserve the running upstream and do not queue inference", async () => {
  const f = await fixture()
  f.hold()
  const { session, events } = await f.connect()
  session.receiveText(create())
  await until(() => f.calls.length === 1)
  session.receiveText(create())
  session.receiveText("{")
  expect(events.filter(e => e.type === "error").map(e => e.status)).toEqual([409, 400])
  expect(f.calls).toHaveLength(1)
  f.release()
  await until(() => events.some(e => e.type === "response.completed"))
  session.receiveText(create())
  await until(() => events.filter(e => e.type === "response.completed").length === 2)
  expect(f.calls).toHaveLength(2)
})

test("warmup writes no generation usage, billing or performance row", async () => {
  const f = await fixture()
  const { session, events } = await f.connect()
  session.receiveText(create({ generate: false }))
  await until(() => events.some(e => e.type === "response.completed") && f.pending.size === 0)
  for (const table of ["usage", "usage_requests", "performance_summary", "performance_metrics"]) {
    expect(f.external.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
  }
})

test("session and legacy header credentials retain authoritative revocation semantics", async () => {
  const f = await fixture()
  await f.repo.users.update(owner, { userKey: "legacy-secret" })
  await f.repo.sessions.create({ token: "ses_fixture" as import("../../../../src/repo/branded-ids.ts").SessionToken, userId: owner, createdAt: "now", expiresAt: "2099-01-01" })
  const legacy = await f.connect({}, "legacy-secret")
  const session = await f.connect({}, "ses_fixture")
  for (const connection of [legacy, session]) {
    connection.session.receiveText(create({ generate: false }))
    await until(() => connection.events.some(e => e.type === "response.completed"))
  }
  f.external.exec("DELETE FROM user_sessions")
  session.session.receiveText(create())
  await until(() => session.events.some(e => e.type === "error"))
  expect(session.events.at(-1)).toMatchObject({ status: 401 })
  f.external.exec("UPDATE users SET user_key = 'rotated' WHERE id = 'owner'")
  legacy.session.receiveText(create())
  await until(() => legacy.events.some(e => e.type === "error"))
  expect(legacy.events.at(-1)).toMatchObject({ status: 401 })
  expect(f.calls).toHaveLength(0)
})

test("upgrade header policy excludes cookies and queries and preserves header precedence", async () => {
  await fixture()
  for (const request of [
    new Request("http://fixture/v1/responses?key=sk_c12_local_fixture"),
    new Request("http://fixture/v1/responses?key=ignored", { headers: { authorization: "Bearer sk_c12_local_fixture" } }),
    new Request("http://fixture/v1/responses", { headers: { cookie: "session_token=sk_c12_local_fixture" } }),
    new Request("http://fixture/v1/responses", { headers: { "x-api-key": "invalid", authorization: "Bearer sk_c12_local_fixture" } }),
  ]) await expect(authorizeResponsesSession(request)).rejects.toThrow()
  const allowed = await authorizeResponsesSession(new Request("http://fixture/v1/responses", { headers: { "x-api-key": "sk_c12_local_fixture", authorization: "Bearer invalid" } }))
  expect(allowed.identity.apiKeyId).toBe(keyId)
})

test("external mapping and model eligibility changes are rechecked after warmup", async () => {
  const f = await fixture()
  const connection = await f.connect()
  connection.session.receiveText(create({ generate: false }))
  await until(() => connection.events.some(e => e.type === "response.completed"))
  const id = (connection.events.at(-1)?.response as { id: string }).id
  f.external.query("UPDATE api_keys SET model_mappings_enabled = 1, model_mappings = ? WHERE id = 'key'").run(JSON.stringify([{ source: "model", destination: "other" }]))
  connection.session.receiveText(create({ previous_response_id: id, input: [] }))
  await until(() => f.calls.length === 1)
  expect(f.calls[0]?.model).toBe("other")
  await until(() => connection.events.filter(e => e.type === "response.completed").length === 2)
  f.external.exec("UPDATE upstreams SET enabled = 0 WHERE id = 'up'")
  connection.session.receiveText(create({ generate: false }))
  await until(() => connection.events.some(e => e.type === "error"))
  expect(connection.events.at(-1)).toMatchObject({ status: 404 })
  expect(f.calls).toHaveLength(1)
})

test("warmup and generation share the real quota denial", async () => {
  const f = await fixture()
  const key = await f.repo.apiKeys.getById(keyId)
  if (!key) throw new Error("missing key")
  await f.repo.apiKeys.save({ ...key, quotaRequestsPerMonth: 0 })
  const connection = await f.connect()
  for (const generate of [false, true]) {
    const count = connection.events.length
    connection.session.receiveText(create({ generate }))
    await until(() => connection.events.length > count && connection.session.state === "idle")
    expect(connection.events.at(-1)).toMatchObject({ type: "error", status: 429 })
  }
  expect(f.calls).toHaveLength(0)
})

test("a dropped terminal cancels instead of making local state reusable or replaying inference", async () => {
  const f = await fixture()
  const sent: string[] = []
  const { session, closes } = await f.connect({ sendText(text) { sent.push(text); return text.includes('"type":"response.completed"') ? "failed" : "accepted" } })
  session.receiveText(create())
  await until(() => closes.length > 0)
  expect(f.calls).toHaveLength(1)
  expect(sent.filter(text => text.includes('"type":"response.completed"'))).toHaveLength(1)
  expect((await session.close()).cleanupComplete).toBe(true)
})

test("durable save and prior telemetry cleanup gate immediate next-turn inference", async () => {
  const f = await fixture()
  const key = await f.repo.apiKeys.getById(keyId)
  if (!key) throw new Error("missing key")
  await f.repo.apiKeys.save({ ...key, responsesRetentionSeconds: 86400 })
  const saveGate = Promise.withResolvers<void>()
  const cleanupGate = Promise.withResolvers<void>()
  let saves = 0
  initResponsesStore({ load: (...args) => f.store.load(...args), save: async snapshot => { saves++; await saveGate.promise; await f.store.save(snapshot) } })
  const record = f.repo.performance.record.bind(f.repo.performance)
  let recording = false
  f.repo.performance.record = async row => { recording = true; await cleanupGate.promise; await record(row) }
  const connection = await f.connect()
  try {
    connection.session.receiveText(create({ store: true }))
    await until(() => saves === 1)
    expect(connection.events.some(e => e.type === "response.completed")).toBe(false)
    saveGate.resolve()
    await until(() => connection.events.some(e => e.type === "response.completed") && recording)
    connection.session.receiveText(create({ previous_response_id: "resp_1", input: [] }))
    await Bun.sleep(15)
    expect(f.calls).toHaveLength(1)
    expect(connection.session.state).toBe("running")
    cleanupGate.resolve()
    await until(() => connection.events.filter(e => e.type === "response.completed").length === 2)
    expect(f.calls).toHaveLength(2)
    expect(await f.store.load("resp_1", keyId)).not.toBeNull()
  } finally { saveGate.resolve(); cleanupGate.resolve() }
})

import { RESPONSES_WS_MAX_OUTBOUND_FRAME_BYTES, RESPONSES_WS_SEND_HIGH_WATER_BYTES, RESPONSES_WS_MAX_TURN_EVENT_BYTES, RESPONSES_WS_UNOBSERVABLE_LIFETIME_BYTES, RESPONSES_WS_CLEANUP_TIMEOUT_MS, RESPONSES_WS_DRAIN_TIMEOUT_MS, utf8Bytes } from "../../../../src/data-plane/chat-flow/responses/session-limits.ts"

class TestClock implements ResponsesSessionClock {
  time = 0
  readonly scheduled = new Map<() => void, number>()
  now = () => this.time
  schedule = (callback: () => void, milliseconds: number) => { this.scheduled.set(callback, this.time + milliseconds); return () => { this.scheduled.delete(callback) } }
  advance(milliseconds: number) {
    this.time += milliseconds
    for (const [callback, at] of [...this.scheduled]) if (at <= this.time) { this.scheduled.delete(callback); callback() }
  }
}

for (const delta of [-1, 0, 1]) {
  test(`observable buffer plus control frame highwater ${delta >= 0 ? "+" : ""}${delta}`, async () => {
    const f = await fixture()
    let buffered = 0
    const c = await f.connect({ pressure: { kind: "observable", bufferedBytes: () => buffered } })
    c.session.receiveText("{")
    const bytes = utf8Bytes(JSON.stringify(c.events[0]))
    buffered = RESPONSES_WS_SEND_HIGH_WATER_BYTES - bytes + delta
    c.session.receiveText("{")
    expect(c.events).toHaveLength(delta > 0 ? 1 : 2)
    expect(c.closes.length > 0).toBe(delta > 0)
  })

  test(`canonical outbound frame byte limit ${delta >= 0 ? "+" : ""}${delta}`, async () => {
    const f = await fixture()
    const base = { type: "response.in_progress", sequence_number: 1, response: { id: "resp_1", model: "model", status: "in_progress" }, padding: "" }
    const padding = "x".repeat(RESPONSES_WS_MAX_OUTBOUND_FRAME_BYTES + delta - utf8Bytes(JSON.stringify(base)))
    f.extraEvents([{ ...base, padding }])
    const c = await f.connect()
    c.session.receiveText(create())
    await until(() => c.closes.length > 0 || c.events.some(e => e.type === "response.completed"))
    const progress = c.events.find(e => e.type === "response.in_progress")
    if (delta > 0) { expect(progress).toBeUndefined(); expect(c.closes).toContain(1009) }
    else { expect(utf8Bytes(JSON.stringify(progress))).toBe(RESPONSES_WS_MAX_OUTBOUND_FRAME_BYTES + delta); expect(c.closes).toHaveLength(0) }
  })
}

test("Bun-style backpressured acceptance enqueues once and resumes only on drain", async () => {
  const f = await fixture()
  const sent: Record<string, unknown>[] = []
  const c = await f.connect({ pressure: { kind: "observable", bufferedBytes: () => 0 }, sendText(text) { sent.push(JSON.parse(text)); return sent.length === 1 ? "backpressured" : "accepted" } })
  c.session.receiveText(create())
  await until(() => sent.length === 1)
  await Bun.sleep(10)
  expect(sent).toHaveLength(1)
  c.session.drain()
  await until(() => sent.some(e => e.type === "response.completed"))
  expect(sent.map(e => e.type)).toEqual(["response.created", "response.output_item.added", "response.output_item.done", "response.in_progress", "response.completed"])
  expect(f.calls).toHaveLength(1)
})

test("drain deadline closes and prevents inference while admission is backpressured", async () => {
  const f = await fixture()
  const clock = new TestClock()
  const c = await f.connect({ pressure: { kind: "observable", bufferedBytes: () => RESPONSES_WS_SEND_HIGH_WATER_BYTES + 1 } }, "sk_c12_local_fixture", clock)
  c.session.receiveText(create())
  await until(() => clock.scheduled.size > 0)
  clock.advance(RESPONSES_WS_DRAIN_TIMEOUT_MS - 1)
  await Bun.sleep(1)
  expect(c.closes).toHaveLength(0)
  clock.advance(1)
  await until(() => c.closes.length > 0)
  expect(f.calls).toHaveLength(0)
})

test("blocked cleanup admits only one successor, closes at its deadline and reports incomplete close", async () => {
  const f = await fixture()
  const clock = new TestClock()
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const record = f.repo.performance.record.bind(f.repo.performance)
  f.repo.performance.record = async row => { started.resolve(); await gate.promise; await record(row) }
  const c = await f.connect({}, "sk_c12_local_fixture", clock)
  try {
    c.session.receiveText(create())
    await started.promise
    expect(c.events.at(-1)?.type).toBe("response.completed")
    c.session.receiveText(create({ input: "second" }))
    c.session.receiveText(create({ input: "third" }))
    expect(c.events.at(-1)).toMatchObject({ status: 409 })
    clock.advance(RESPONSES_WS_CLEANUP_TIMEOUT_MS)
    await until(() => c.closes.length > 0)
    expect(f.calls).toHaveLength(1)
    const closing = c.session.close()
    clock.advance(RESPONSES_WS_CLEANUP_TIMEOUT_MS)
    expect(await closing).toEqual({ cleanupComplete: false })
  } finally { gate.resolve() }
})

test("unobservable connection lifetime counts output across turns without pretending it drained", async () => {
  const f = await fixture()
  const event = { type: "response.in_progress", response: { id: "r", model: "model", status: "in_progress" }, padding: "x".repeat(700_000) }
  f.extraEvents([event, event, event, event])
  let sentBytes = 0
  let terminals = 0
  const c = await f.connect({ sendText(text) { sentBytes += utf8Bytes(text); if (JSON.parse(text).type === "response.completed") terminals++; return "accepted" } })
  for (let index = 0; index < 7 && c.closes.length === 0; index++) {
    const before = terminals
    c.session.receiveText(create())
    await until(() => c.closes.length > 0 || terminals > before)
  }
  expect(c.closes).toContain(1009)
  expect(terminals).toBeGreaterThan(1)
  expect(sentBytes).toBeLessThanOrEqual(RESPONSES_WS_UNOBSERVABLE_LIFETIME_BYTES)
  expect(sentBytes + utf8Bytes(JSON.stringify(event))).toBeGreaterThan(RESPONSES_WS_UNOBSERVABLE_LIFETIME_BYTES)
})

test("aggregate turn event budget rejects many legal frames on an observable transport", async () => {
  const f = await fixture()
  const event = { type: "response.in_progress", response: { id: "r", model: "model", status: "in_progress" }, padding: "x".repeat(700_000) }
  f.extraEvents(Array.from({ length: 25 }, () => event))
  let sentBytes = 0
  const c = await f.connect({ pressure: { kind: "observable", bufferedBytes: () => 0 }, sendText(text) { sentBytes += utf8Bytes(text); return "accepted" } })
  c.session.receiveText(create())
  await until(() => c.closes.length > 0)
  expect(c.closes).toContain(1009)
  expect(sentBytes).toBeLessThanOrEqual(RESPONSES_WS_MAX_TURN_EVENT_BYTES)
  expect(sentBytes + utf8Bytes(JSON.stringify(event))).toBeGreaterThan(RESPONSES_WS_MAX_TURN_EVENT_BYTES)
})

test("native close reentrancy is idempotent", async () => {
  const f = await fixture()
  const holder: { session?: ReturnType<typeof createResponsesSession> } = {}
  let closes = 0
  const c = await f.connect({ close() { closes++; void holder.session?.close() } })
  holder.session = c.session
  await c.session.close()
  expect(closes).toBe(1)
})

for (const unobservable of [false, true]) {
  for (const delta of [-1, 0, 1]) {
    test(`${unobservable ? "connection lifetime" : "per-turn aggregate"} exact byte boundary ${delta >= 0 ? "+" : ""}${delta}`, async () => {
      const f = await fixture()
      let total = 0
      const observed: Record<string, unknown>[] = []
      const c = await f.connect({ pressure: unobservable ? { kind: "unobservable" } : { kind: "observable", bufferedBytes: () => 0 }, sendText(text) { total += utf8Bytes(text); observed.push(JSON.parse(text)); return "accepted" } })
      const count = 17
      const base = { type: "response.in_progress", sequence_number: 1, response: { id: "r", model: "model", status: "in_progress" }, padding: "" }
      f.extraEvents(Array.from({ length: count }, () => base))
      c.session.receiveText(create())
      await until(() => observed.some(e => e.type === "response.completed") && c.session.state === "idle")
      const priorTotal = total
      // Rehearse the same frame count to measure all origin envelopes and
      // canonical sequence digits. resp_1/resp_2 and issued tokens have equal size.
      const fixed = priorTotal
      const target = (unobservable ? RESPONSES_WS_UNOBSERVABLE_LIFETIME_BYTES - priorTotal : RESPONSES_WS_MAX_TURN_EVENT_BYTES) + delta
      let remainder = target - fixed
      const extra = Array.from({ length: count }, (_, index) => {
        const bytes = Math.floor(remainder / (count - index))
        remainder -= bytes
        return { ...base, padding: "x".repeat(bytes) }
      })
      f.extraEvents(extra)
      c.session.receiveText(create())
      await until(() => c.closes.length > 0 || observed.filter(e => e.type === "response.completed").length === 2)
      if (delta > 0) { expect(c.closes).toContain(1009); expect(observed.filter(e => e.type === "response.completed")).toHaveLength(1) }
      else { expect(total - priorTotal).toBe(target); expect(c.closes).toHaveLength(0) }
    })
  }
}

test("accepted failure evicts warmup history and permits a full fresh request after cleanup", async () => {
  const f = await fixture()
  const c = await f.connect()
  c.session.receiveText(create({ generate: false }))
  await until(() => c.events.some(e => e.type === "response.completed"))
  const id = (c.events.at(-1)?.response as { id: string }).id
  f.fail()
  c.session.receiveText(create({ previous_response_id: id, input: [] }))
  await until(() => c.events.some(e => e.type === "response.failed") && c.session.state === "idle")
  c.session.receiveText(create({ previous_response_id: id, input: [] }))
  await until(() => c.events.some(e => e.type === "error") && c.session.state === "idle")
  expect(c.events.at(-1)).toMatchObject({ error: { code: "previous_response_not_found" } })
  f.fail(false)
  c.session.receiveText(create())
  await until(() => c.events.filter(e => e.type === "response.completed").length === 2)
  expect(f.calls).toHaveLength(2)
})

test("real SQLite durable save failure emits failure and cannot publish connection state", async () => {
  const f = await fixture()
  const key = await f.repo.apiKeys.getById(keyId)
  if (!key) throw new Error("missing key")
  await f.repo.apiKeys.save({ ...key, responsesRetentionSeconds: 86400 })
  f.external.exec("CREATE TRIGGER fail_response_save BEFORE INSERT ON responses_snapshots BEGIN SELECT RAISE(FAIL, 'private save details'); END")
  const c = await f.connect()
  c.session.receiveText(create({ store: true }))
  await until(() => c.events.some(e => e.type === "response.failed") && c.session.state === "idle")
  expect(c.events.some(e => e.type === "response.completed")).toBe(false)
  expect(JSON.stringify(c.events)).not.toContain("private save details")
  expect(await f.store.load("resp_1", keyId)).toBeNull()
  c.session.receiveText(create({ previous_response_id: "resp_1", input: [] }))
  await until(() => c.events.some(e => e.type === "error"))
  expect(c.events.at(-1)).toMatchObject({ error: { code: "previous_response_not_found" } })
})

test("close during a fresh configuration read prevents subsequent preparation and inference", async () => {
  const f = await fixture()
  const c = await f.connect()
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const revision = f.repo.configurationRevision?.bind(f.repo)
  if (!revision) throw new Error("missing revision")
  f.repo.configurationRevision = async () => { const current = await revision(); started.resolve(); await gate.promise; return current }
  c.session.receiveText(create())
  await started.promise
  expect(f.pending.size).toBeGreaterThan(0)
  const closed = c.session.close()
  gate.resolve()
  expect(await closed).toEqual({ cleanupComplete: true })
  expect(f.calls).toHaveLength(0)
  expect(c.events).toHaveLength(0)
})

for (const mutation of ["UPDATE api_keys SET owner_id = 'other-owner' WHERE id = 'key'", "UPDATE api_keys SET key = 'rotated' WHERE id = 'key'", "UPDATE api_keys SET id = 'other-id' WHERE id = 'key'"]) {
  test(`original credential identity fence rejects external mutation: ${mutation.split(" SET ")[1]?.split(" WHERE ")[0]}`, async () => {
    const f = await fixture()
    await f.repo.users.create({ id: "other-owner" as UserId, name: "other", disabled: false, createdAt: "now" })
    const c = await f.connect()
    f.external.exec(mutation)
    c.session.receiveText(create())
    await until(() => c.events.some(e => e.type === "error"))
    expect(c.events.at(-1)).toMatchObject({ status: 401 })
    expect(f.calls).toHaveLength(0)
  })
}

test("session expiry is checked again on the original header credential", async () => {
  const f = await fixture()
  await f.repo.sessions.create({ token: "ses_expiry" as import("../../../../src/repo/branded-ids.ts").SessionToken, userId: owner, createdAt: "now", expiresAt: "2099-01-01" })
  const c = await f.connect({}, "ses_expiry")
  f.external.exec("UPDATE user_sessions SET expires_at = '2000-01-01'")
  c.session.receiveText(create())
  await until(() => c.events.some(e => e.type === "error"))
  expect(c.events.at(-1)).toMatchObject({ status: 401 })
  expect(f.calls).toHaveLength(0)
})

for (const delta of [-1, 0, 1]) {
  test(`cumulative control replies enforce 64 KiB boundary ${delta >= 0 ? "+" : ""}${delta}`, async () => {
    const f = await fixture()
    const sample = await f.connect()
    const short = create({ event_id: "unsupported" })
    const long = create({ stream_id: "unsupported" })
    sample.session.receiveText(short)
    sample.session.receiveText(long)
    const a = utf8Bytes(JSON.stringify(sample.events[0]))
    const b = utf8Bytes(JSON.stringify(sample.events[1]))
    expect(b - a).toBe(1)
    const c = await f.connect()
    const target = 65_536 + delta
    const count = Math.floor(target / a)
    const extra = target - count * a
    expect(extra).toBeLessThan(count)
    for (let index = 0; index < count; index++) c.session.receiveText(index < count - extra ? short : long)
    const sent = c.events.reduce((sum, event) => sum + utf8Bytes(JSON.stringify(event)), 0)
    if (delta > 0) { expect(sent).toBeLessThanOrEqual(65_536); expect(c.closes).toContain(1009) }
    else { expect(sent).toBe(target); expect(c.closes).toHaveLength(0) }
    expect(f.calls).toHaveLength(0)
  })
}

test("native send rechecks pressure changed after the asynchronous capacity check", async () => {
  const f = await fixture()
  let buffered = 0
  let reads = 0
  let overshoots = 0
  const c = await f.connect({
    pressure: { kind: "observable", bufferedBytes() {
      if (++reads === 2) queueMicrotask(() => { buffered = RESPONSES_WS_SEND_HIGH_WATER_BYTES })
      return buffered
    } },
    sendText(text) { if (buffered + utf8Bytes(text) > RESPONSES_WS_SEND_HIGH_WATER_BYTES) overshoots++; return "accepted" },
  })
  c.session.receiveText(create())
  await until(() => overshoots > 0 || c.closes.length > 0)
  expect(overshoots).toBe(0)
})

test("synchronous native disconnect during terminal acceptance cannot reopen admission", async () => {
  const f = await fixture()
  const holder: { session?: ReturnType<typeof createResponsesSession> } = {}
  let disconnected = false
  const c = await f.connect({ sendText(text) {
    if (!disconnected && JSON.parse(text).type === "response.completed") {
      disconnected = true
      void holder.session?.close()
      queueMicrotask(() => holder.session?.receiveText(create({ input: "must not execute" })))
    }
    return "accepted"
  } })
  holder.session = c.session
  c.session.receiveText(create())
  await until(() => disconnected)
  await c.session.close()
  await Bun.sleep(15)
  expect(f.calls).toHaveLength(1)
  expect(c.session.state).toBe("closed")
})
