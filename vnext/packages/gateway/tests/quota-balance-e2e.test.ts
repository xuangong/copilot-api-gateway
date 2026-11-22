/**
 * Upstream quota balancing end to end: the real app on SQLite, two Copilot members behind a fake GitHub / Copilot, real key and session auth,
 * the real reader, selection, cut-off and protection, injected clocks (no timers, no background executor).
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initBackground, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { app } from "../src/app"
import { initRepo } from "../src/repo/index"
import { listUpstreamModels } from "../src/data-plane/providers/registry"
import { ProtectionRuntime, setProtectionForTests } from "../src/protection/runtime"
import { QuotaBalance, setQuotaBalanceForTests, setQuotaFetcherFactory } from "../src/quota-balance/runtime"
import { sweepQuotaBalance } from "../src/quota-balance/sweep"
import type { ApiKeyId, SessionToken, UserId } from "../src/repo/branded-ids"

const OWNER = "user_e2e_qb" as UserId
const SESSION = "ses_e2e_qb"
const KEY = "key_e2e_qb"
const SECRET = "fake_e2e_qb_secret"
const ENV = { SERVER_SECRET: "e2e-qb" }
const TOKENS = { up_test_ma: "fake_github_token_a", up_test_mb: "fake_github_token_b" } as const
const MEMBER_OF = Object.fromEntries(Object.entries(TOKENS).map(([id, token]) => [`cptoken_${token}`, id])) as Record<string, string>
const originalFetch = globalThis.fetch

let db: Database
let repo: BunSqliteRepo
let qb: QuotaBalance
let clock: { now: number }
let pending: Array<Promise<unknown>>
let quota: Record<string, { entitlement: number; remaining: number }>
let served: string[]
let userCalls: number
let failUser = false

const model = (id: string, type: string) => ({
  id, object: "model", name: id, vendor: "openai", version: id, model_picker_enabled: true, preview: false,
  capabilities: { family: "openai", limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 }, object: "model_capabilities", supports: {}, tokenizer: "cl100k", type },
})

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  initRuntimeLocation("bun")
  initBackground({ waitUntil: () => {} })
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  const stamp = new Date().toISOString()
  await repo.users.create({ id: OWNER, name: "owner", email: "owner@example.invalid", disabled: false, createdAt: stamp })
  await repo.sessions.create({ token: SESSION as SessionToken, userId: OWNER, createdAt: stamp, authenticatedAt: Date.now(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
  await repo.apiKeys.save({ id: KEY as ApiKeyId, ownerId: OWNER, name: KEY, key: SECRET, createdAt: stamp, modelMappingsEnabled: false, modelMappings: [] })
  for (const [index, [id, token]] of Object.entries(TOKENS).entries()) {
    await repo.upstreams.save({ id, ownerId: OWNER, provider: "copilot", name: id, enabled: true, sortOrder: index,
      config: { githubToken: token, accountType: "individual", user: { id: index + 1, login: `acct${index}` } },
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "direct_fetch" }], state: null, createdAt: stamp, updatedAt: stamp })
  }
  quota = { [TOKENS.up_test_ma]: { entitlement: 1000, remaining: 800 }, [TOKENS.up_test_mb]: { entitlement: 1000, remaining: 400 } }
  served = []
  userCalls = 0
  failUser = false
  pending = []
  clock = { now: Date.UTC(2026, 10, 22, 12, 0, 0) }
  const protection = new ProtectionRuntime({ repo: () => repo, now: () => clock.now, schedule: work => { pending.push(work.catch(() => {})) }, cacheTtlMs: 0, evalIntervalMs: 0 })
  setProtectionForTests(protection)
  qb = new QuotaBalance({ repo: () => repo, now: () => clock.now, schedule: work => { pending.push(work.catch(() => {})) }, random: () => 0.5 }, { protection: () => protection })
  // Cost-triggered evaluation is covered by its unit tests; here the reads are driven explicitly (Refresh and the sweep) so the clock stays deterministic.
  qb.reader.evaluateSoon = async () => {}
  setQuotaBalanceForTests(qb)
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(req.url)
    const auth = req.headers.get("authorization") ?? ""
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/copilot_internal/v2/token")) {
      return Response.json({ token: `cptoken_${auth.replace(/^token /, "")}`, expires_at: Math.floor(Date.now() / 1000) + 3600 })
    }
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/copilot_internal/user")) {
      userCalls++
      if (failUser) return new Response("{}", { status: 500 })
      const q = quota[auth.replace(/^token /, "")]!
      return Response.json({ quota_snapshots: { premium_interactions: { entitlement: q.entitlement, remaining: q.remaining, unlimited: false } } })
    }
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [model("gpt-4o-mini", "chat"), model("text-embedding-3-small", "embedding")] })
    if (url.pathname.endsWith("/chat/completions")) {
      served.push(MEMBER_OF[auth.replace(/^Bearer /, "")] ?? "unknown")
      return Response.json({ id: "c1", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    }
    if (url.pathname.endsWith("/embeddings")) {
      served.push(MEMBER_OF[auth.replace(/^Bearer /, "")] ?? "unknown")
      return Response.json({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], model: "text-embedding-3-small", usage: { prompt_tokens: 3, total_tokens: 3 } })
    }
    if (url.pathname.endsWith("/v1/messages/count_tokens")) {
      served.push(MEMBER_OF[auth.replace(/^Bearer /, "")] ?? "unknown")
      return Response.json({ input_tokens: 7 })
    }
    return new Response("unexpected request in the e2e fake", { status: 599 }) // never the network
  }) as typeof fetch
  globalThis.fetch = fake
  setQuotaFetcherFactory(async () => fake)
  await listUpstreamModels()
})
afterEach(() => { globalThis.fetch = originalFetch; setQuotaBalanceForTests(null); setProtectionForTests(null); setQuotaFetcherFactory(async () => fetch); db.close(); __resetPlatformForTests() })

const idle = async () => { while (pending.length) await Promise.all(pending.splice(0)) }
const session = (path: string, method = "GET", body?: unknown) => app.request(`http://localhost${path}`, {
  method, headers: { cookie: `session_token=${SESSION}`, origin: "http://localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, ENV)
const json = async (response: Response) => (await response.json()) as any
async function chat(sessionId: string, modelId = "gpt-4o-mini") {
  const before = served.length
  const response = await app.request("/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": SECRET },
    body: JSON.stringify({ model: modelId, prompt_cache_key: sessionId, messages: [{ role: "user", content: "hello" }] }),
  }, ENV)
  const body = await response.text()
  await idle()
  return { status: response.status, headers: response.headers, body, member: served.length > before ? served.at(-1)! : null }
}
/** POST /v1/messages like Claude Code: the session comes from the `x-claude-code-session-id` header. */
async function message(sessionId: string, modelId = "gpt-4o-mini") {
  const before = served.length
  const response = await app.request("/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": SECRET, "anthropic-version": "2023-06-01", "x-claude-code-session-id": sessionId },
    body: JSON.stringify({ model: modelId, max_tokens: 64, messages: [{ role: "user", content: `hello ${sessionId}` }] }),
  }, ENV)
  const body = await response.text()
  await idle()
  return { status: response.status, headers: response.headers, body, member: served.length > before ? served.at(-1)! : null }
}
/** Ollama /api/chat: no session id on the wire, the identity is the first user message (and system prompt). */
async function ollama(first: string, extra: Array<{ role: string; content: string }> = []) {
  const before = served.length
  const response = await app.request("/api/chat", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": SECRET },
    body: JSON.stringify({ model: "gpt-4o-mini", stream: false, messages: [{ role: "user", content: first }, ...extra] }),
  }, ENV)
  const body = await response.text()
  await idle()
  return { status: response.status, body, member: served.length > before ? served.at(-1)! : null }
}
const assignments = () => db.query("SELECT upstream_id, recent_cost_usd FROM session_assignments").all() as Array<{ upstream_id: string; recent_cost_usd: number }>
const costBuckets = () => db.query("SELECT upstream_id, SUM(cost_usd) AS cost FROM upstream_cost_buckets GROUP BY upstream_id").all() as Array<{ upstream_id: string; cost: number }>
/** A group with both members, read once: A at `a`, B at `b` of the allowance. */
async function pool(a: number, b: number, settings: Record<string, unknown> = {}, sortOrder?: number) {
  const { group } = await json(await session("/api/upstream-groups", "POST", { name: "Pool", settings: { idleRebalanceMinutes: 600, ...settings }, ...(sortOrder === undefined ? {} : { sortOrder }) }))
  setQuota("up_test_ma", a); setQuota("up_test_mb", b)
  await join(group.id)
  return group.id as string
}

/** Advances the injected clock (70 minutes by default, past every floor) and asks the API for a live read of the member. */
const refresh = async (id: string, advanceMs = 70 * 60_000) => { clock.now += advanceMs; return json(await session(`/api/upstreams/${id}/quota/refresh`, "POST")) }
/** Puts both members in the group; each one's first (join) read runs in the background and is awaited. */
async function join(groupId: string) {
  for (const id of Object.keys(TOKENS)) expect((await session(`/api/upstreams/${id}/group`, "PUT", { groupId })).status).toBe(200)
  await idle()
}
const setQuota = (id: keyof typeof TOKENS, usedShare: number, entitlement = 1000) => { quota[TOKENS[id]] = { entitlement, remaining: Math.round(entitlement * (1 - usedShare)) } }
const status = async (groupId: string) => json(await session(`/api/upstream-groups/${groupId}/status`))
const alerts = async () => (await json(await session("/api/upstream-groups/alerts"))).alerts

test("balancing by session across two members: sticky sessions, outside usage, the soft line, exhaustion, overage, the hard line, recovery, entitlement change, monthly reset", async () => {
  // Setup through the API: a group whose idle time is long enough that sessions never count as idle between the clock jumps below.
  const { group } = await json(await session("/api/upstream-groups", "POST", { name: "Pool", settings: { idleRebalanceMinutes: 600 } }))
  setQuota("up_test_ma", 0.2); setQuota("up_test_mb", 0.6)
  await join(group.id)
  expect(userCalls).toBe(2) // the join reads
  let s = await status(group.id)
  expect(s.state).toBe("normal")
  expect(s.members.map((m: any) => [m.upstreamId, m.usedShare, m.eligibility.eligible])).toEqual([["up_test_ma", 0.2, true], ["up_test_mb", 0.6, true]])

  // 1. A new session goes to the member with the lowest projected share and stays there; the assignment is stored.
  expect((await chat("conv-x")).member).toBe("up_test_ma")
  expect((await chat("conv-x")).member).toBe("up_test_ma")
  expect(db.query("SELECT upstream_id FROM session_assignments").all()).toEqual([{ upstream_id: "up_test_ma" }])
  expect((await status(group.id)).members[0].activeSessions).toBe(1)

  // 2. A jumps from 20 % to 62 % (more than B's 60 %): new sessions go to B, the running session stays (o is not learned yet: k has no 3 intervals).
  setQuota("up_test_ma", 0.62); setQuota("up_test_mb", 0.6)
  await refresh("up_test_ma"); await refresh("up_test_mb", 0)
  expect((await chat("conv-y")).member).toBe("up_test_mb")
  expect((await chat("conv-y")).member).toBe("up_test_mb")
  expect((await chat("conv-x")).member).toBe("up_test_ma")

  // 3. A reaches the soft line: new sessions avoid it, the running session continues, pinned requests and embeddings behave.
  setQuota("up_test_ma", 0.93)
  await refresh("up_test_ma")
  for (const id of ["conv-z1", "conv-z2", "conv-z3"]) expect((await chat(id)).member).toBe("up_test_mb")
  expect((await chat("conv-x")).member).toBe("up_test_ma")
  expect((await chat("conv-pin", "up_test_ma/gpt-4o-mini")).member).toBe("up_test_ma")
  s = await status(group.id)
  expect(s.members[0].eligibility).toEqual({ eligible: false, reason: "soft_line" })
  const embeddings = await app.request("/v1/embeddings", { method: "POST", headers: { "content-type": "application/json", "x-api-key": SECRET }, body: JSON.stringify({ model: "text-embedding-3-small", input: "x" }) }, ENV)
  expect(embeddings.status).toBe(200)
  expect(served.at(-1)).toBe("up_test_mb")

  // 4. B reaches the soft line too: nobody can take a new session (503, nothing behind the group); running sessions continue.
  setQuota("up_test_mb", 0.93)
  await refresh("up_test_mb")
  const stopped = await chat("conv-new")
  expect(stopped.status).toBe(503)
  expect(Number(stopped.headers.get("retry-after"))).toBeGreaterThan(0)
  expect(JSON.parse(stopped.body)).toMatchObject({ error: { code: "group_quota_exhausted" } })
  expect((await chat("conv-x")).member).toBe("up_test_ma")
  expect((await chat("conv-y")).member).toBe("up_test_mb")
  s = await status(group.id)
  expect(s.state).toBe("stopped")
  expect(await alerts()).toEqual([{ kind: "stopped", groupId: group.id, groupName: "Pool" }])

  // 5. The overage policy lets new sessions use members above the soft line, and the dashboard warns.
  expect((await session(`/api/upstream-groups/${group.id}`, "PATCH", { settings: { exhaustedPolicy: "overage" } })).status).toBe(200)
  await qb.directory.get({ fresh: true })
  expect((await chat("conv-over")).status).toBe(200)
  expect(await alerts()).toEqual([{ kind: "overage", groupId: group.id, groupName: "Pool" }])
  await session(`/api/upstream-groups/${group.id}`, "PATCH", { settings: { exhaustedPolicy: "stop" } })
  await qb.directory.get({ fresh: true })

  // 6. A reaches the hard line: cut off until the monthly reset; its session is served by B (the only member left); the pause is listed for the banner.
  setQuota("up_test_ma", 0.97)
  expect((await refresh("up_test_ma")).status).toBe("read")
  const active = (await json(await session("/api/protection/active"))).pauses as any[]
  expect(active).toHaveLength(1)
  expect(active[0]).toMatchObject({ targetId: "up_test_ma", mode: "pause", endsAt: Date.UTC(2026, 11, 1), reason: { trigger: "quota", quota: { share: 0.97, provisional: false, groupName: "Pool" } } })
  // A session of a cut-off member is chosen again like a new one: B is still at the soft line, so it is not a candidate (documented behaviour).
  const moved = await chat("conv-x")
  expect(moved.status).toBe(503)
  expect(JSON.parse(moved.body)).toMatchObject({ error: { code: "group_quota_exhausted" } })
  setQuota("up_test_mb", 0.5)
  await refresh("up_test_mb")
  expect((await chat("conv-x")).member).toBe("up_test_mb")
  expect((await chat("conv-w")).member).toBe("up_test_mb")

  // 7. The owner resumes the pause: it is lifted at once.
  expect((await session(`/api/protection/pauses/${active[0].id}/resume`, "POST")).status).toBe(200)
  expect((await json(await session("/api/protection/active"))).pauses).toEqual([])

  // 8. An entitlement change is recorded and shown; the next read is early.
  setQuota("up_test_mb", 0.4, 2000)
  await refresh("up_test_mb")
  s = await status(group.id)
  const b = s.members.find((m: any) => m.upstreamId === "up_test_mb")
  expect(b.entitlementChange).toMatchObject({ from: 1000, to: 2000 })
  expect(b.intervalHours).toBe(1)
  expect(s.attention.map((x: any) => x.kind)).toContain("entitlement_changed")

  // 9. The monthly reset: both members are read within the jitter window and take sessions again.
  clock.now = Date.UTC(2026, 11, 1, 0, 40)
  setQuota("up_test_ma", 0.02); setQuota("up_test_mb", 0.03, 2000)
  for (let i = 0; i < 3; i++) { await sweepQuotaBalance(clock.now, qb); clock.now += 60_000 }
  s = await status(group.id)
  expect(s.members.map((m: any) => m.eligibility.eligible)).toEqual([true, true])
  expect(s.state).toBe("normal")
  expect((await chat("conv-december")).member).not.toBeNull()
})

test("an upstream behind the group serves when no member can take a new session", async () => {
  const stamp = new Date().toISOString()
  await repo.upstreams.save({ id: "up_test_tail", ownerId: OWNER, provider: "custom", name: "Tail", enabled: true, sortOrder: 50,
    config: { name: "Tail", baseUrl: "https://tail.invalid", authStyle: "none", endpoints: ["chat_completions"], models: ["gpt-4o-mini"] },
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "direct_fetch" }], state: null, createdAt: stamp, updatedAt: stamp })
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    if (req.url.startsWith("https://tail.invalid")) {
      served.push("up_test_tail")
      return Response.json({ id: "t1", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: "tail" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    }
    return previous(input as never, init)
  }) as typeof fetch
  await listUpstreamModels()
  // The group goes before the tail (sort order 5 < 50).
  const { group } = await json(await session("/api/upstream-groups", "POST", { name: "Pool", sortOrder: 5 }))
  setQuota("up_test_ma", 0.2); setQuota("up_test_mb", 0.6)
  await join(group.id)
  expect((await chat("conv-before")).member).toBe("up_test_ma") // the group is first and serves
  setQuota("up_test_ma", 0.93); setQuota("up_test_mb", 0.94)
  await refresh("up_test_ma"); await refresh("up_test_mb", 0)
  const out = await chat("conv-tail")
  expect(out.status).toBe(200)
  expect(out.member).toBe("up_test_tail") // the group is skipped, matching continues with the next item
})

test("Claude Code sessions (messages): sticky by header, one assignment, cost lands on the member and on the assignment; a different session goes to the least projected member", async () => {
  const groupId = await pool(0.2, 0.6)
  expect((await message("cc-1")).member).toBe("up_test_ma")
  // B becomes the lower one (8 points, under migrateShare): the session still stays on A.
  setQuota("up_test_ma", 0.6); setQuota("up_test_mb", 0.52)
  await refresh("up_test_ma"); await refresh("up_test_mb", 0)
  expect((await message("cc-1")).member).toBe("up_test_ma")
  expect(assignments().map(r => r.upstream_id)).toEqual(["up_test_ma"])
  // The cost of both requests is charged to the member that served them, and to the session's assignment.
  const buckets = costBuckets()
  expect(buckets.map(b => b.upstream_id)).toEqual(["up_test_ma"])
  expect(buckets[0]!.cost).toBeGreaterThan(0)
  expect(assignments()[0]!.recent_cost_usd).toBeGreaterThan(0)
  expect(assignments()[0]!.recent_cost_usd).toBeLessThanOrEqual(buckets[0]!.cost + 1e-12)
  expect((await status(groupId)).members.find((m: any) => m.upstreamId === "up_test_ma").activeSessions).toBe(1)
  // A different session: the least projected member now.
  expect((await message("cc-2")).member).toBe("up_test_mb")
  expect(assignments().map(r => r.upstream_id).sort()).toEqual(["up_test_ma", "up_test_mb"])
})

test("the soft line: new sessions get 503 group_quota_exhausted with Retry-After, the existing session keeps being served", async () => {
  const groupId = await pool(0.3, 0.4, { toleranceShare: 0 })
  expect((await message("cc-old")).member).toBe("up_test_ma")
  setQuota("up_test_ma", 0.92); setQuota("up_test_mb", 0.91)
  await refresh("up_test_ma"); await refresh("up_test_mb", 0)
  const refused = await message("cc-new")
  expect(refused.status).toBe(503)
  expect(JSON.parse(refused.body)).toMatchObject({ type: "error", error: { code: "group_quota_exhausted" } })
  const wait = Number(refused.headers.get("retry-after"))
  // Until the next monthly reset: 8.5 days away, not a protection-style minutes-long wait.
  expect(wait).toBeGreaterThan(8 * 86_400)
  expect(wait).toBeLessThanOrEqual(9 * 86_400)
  expect((await message("cc-old")).member).toBe("up_test_ma")
  expect((await status(groupId)).state).toBe("stopped")
  // count_tokens consumes no premium quota: it ignores the soft line.
  const counted = await app.request("/v1/messages/count_tokens", { method: "POST", headers: { "content-type": "application/json", "x-api-key": SECRET, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "x" }] }) }, ENV)
  expect(counted.status).toBe(200)
  expect(served.at(-1)).toBe("up_test_mb") // the lower projected member, although both are at the soft line
})

test("a real read at the hard line cuts the member off and its session moves to the other member", async () => {
  await pool(0.2, 0.4)
  expect((await message("cc-1")).member).toBe("up_test_ma")
  setQuota("up_test_ma", 0.96)
  expect((await refresh("up_test_ma")).status).toBe("read")
  const pauses = (await json(await session("/api/protection/active"))).pauses as any[]
  expect(pauses.map(p => [p.targetId, p.reason.trigger, p.reason.quota.provisional])).toEqual([["up_test_ma", "quota", false]])
  expect((await message("cc-1")).member).toBe("up_test_mb")
  expect(assignments().map(r => r.upstream_id)).toEqual(["up_test_mb"])
  // The cut-off member takes nothing new either.
  expect((await message("cc-2")).member).toBe("up_test_mb")
  // A pinned request is not balanced and does not use a paused upstream.
  expect((await chat("pin", "up_test_ma/gpt-4o-mini")).status).toBe(503)
})

test("an Ollama conversation sticks to one member across turns", async () => {
  await pool(0.2, 0.6)
  const first = await ollama("write a haiku")
  expect(first.status).toBe(200)
  expect(first.member).toBe("up_test_ma")
  setQuota("up_test_ma", 0.6); setQuota("up_test_mb", 0.52)
  await refresh("up_test_ma"); await refresh("up_test_mb", 0)
  const second = await ollama("write a haiku", [{ role: "assistant", content: "hi" }, { role: "user", content: "another" }])
  expect(second.member).toBe("up_test_ma")
  expect(assignments().map(r => r.upstream_id)).toEqual(["up_test_ma"])
  // A different conversation starts on the lower member.
  expect((await ollama("something else")).member).toBe("up_test_mb")
})

test("without groups routing is unchanged: the first upstream serves, nothing is stored, nothing is read", async () => {
  for (const n of [1, 2, 3, 4]) expect((await chat(`conv-${n}`)).member).toBe("up_test_ma")
  expect((await message("cc-1")).member).toBe("up_test_ma")
  expect(assignments()).toEqual([])
  expect(costBuckets()).toEqual([])
  expect(userCalls).toBe(0)
  expect((await sweepQuotaBalance(clock.now, qb)).members).toBe(0)
})

test("a member that was never read successfully takes no sessions (not 0 %), is flagged for the banner, and serves once calibrated", async () => {
  failUser = true
  const groupId = await pool(0.2, 0.6) // both join reads fail
  expect(userCalls).toBe(2)
  const refused = await chat("conv-never")
  expect(refused.member).toBeNull()
  expect(refused.status).not.toBe(200)
  expect(refused.body).not.toContain("group_quota_exhausted") // no data is not a quota statement
  let s = await status(groupId)
  expect(s.members.map((m: any) => [m.eligibility.reason, m.readFailingReason])).toEqual([["no_read", "never_read"], ["no_read", "never_read"]])
  expect(s.state).toBe("unknown")
  expect(await alerts()).toEqual([
    { kind: "read_failing", reason: "never_read", groupId, groupName: "Pool", upstreamId: "up_test_ma", upstreamName: "up_test_ma" },
    { kind: "read_failing", reason: "never_read", groupId, groupName: "Pool", upstreamId: "up_test_mb", upstreamName: "up_test_mb" },
  ])
  expect((await session("/api/upstreams/up_test_ma/quota/calibrate", "POST", { usedShare: 0.3 })).status).toBe(200)
  s = await status(groupId)
  expect(s.members[0].eligibility.eligible).toBe(true)
  expect((await chat("conv-never")).member).toBe("up_test_ma")
})
