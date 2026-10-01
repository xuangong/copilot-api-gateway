import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { SSEStreamingApi } from "hono/streaming"
import type { BoundedChannelSubscription, ChannelQueuePolicy } from "../src/shared/runtime/channel-broker-contract.ts"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { dumpRoutes } from "../src/control-plane/dump/routes.ts"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth.ts"
import { initRepo } from "../src/repo/index.ts"
import type { ApiKeyId, SessionToken, UserId } from "../src/repo/branded-ids.ts"
import { dumpCodec } from "../src/shared/dump/codec.ts"
import { initDumpBroker, initDumpStore, resetDumpRegistryForTests } from "../src/shared/dump/registry.ts"
import type { DumpStore } from "../src/shared/dump/store-contract.ts"
import type { DumpMetadata, PreparedDumpRequestBody, StoredDumpRecord } from "../src/shared/dump/types.ts"
import { EventTargetChannelBroker } from "../src/shared/runtime/event-target-channel-broker.ts"

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("deferred not initialized") }
  let reject: (error: unknown) => void = () => { throw new Error("deferred not initialized") }
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Only the snapshot timing is controlled. Authorization uses SQLite and the
// subscription, queue, codec and cancellation behavior are the real broker.
class SnapshotStore implements DumpStore {
  readonly started = deferred<void>()
  readonly read = deferred<DumpMetadata[]>()
  reads = 0

  async list(): Promise<DumpMetadata[]> {
    this.reads++
    this.started.resolve()
    return await this.read.promise
  }

  async prepareRequestBody(): Promise<PreparedDumpRequestBody> { throw new Error("unexpected body preparation") }
  async put(): Promise<void> { throw new Error("unexpected write") }
  async get(): Promise<StoredDumpRecord | null> { throw new Error("unexpected detail read") }
  async deleteExpiredBatch(): Promise<number> { throw new Error("unexpected deletion") }
  async findOldestCreatedAt(): Promise<number | null> { throw new Error("unexpected retention read") }
}

class ObservedBroker extends EventTargetChannelBroker<DumpMetadata> {
  readonly subscriptions: Array<{ signal: AbortSignal; iterable: AsyncIterable<DumpMetadata> }> = []
  encoded = 0
  onDecode: (() => void) | undefined

  constructor() {
    super({ encode: value => { this.encoded++; return dumpCodec.encode(value) }, decode: payload => { const value = dumpCodec.decode(payload); this.onDecode?.(); return value } })
  }

  override subscribeBounded(channelId: string, signal: AbortSignal, policy: ChannelQueuePolicy): BoundedChannelSubscription<DumpMetadata> {
    const handle = super.subscribeBounded(channelId, signal, policy)
    this.subscriptions.push({ signal, iterable: handle.iterable })
    return handle
  }

  first() {
    const subscription = this.subscriptions[0]
    if (!subscription) throw new Error("subscription did not start")
    return subscription
  }
}

const meta = (id: string): DumpMetadata => ({
  id, startedAt: 0, completedAt: 1, method: "POST", path: "/v1/responses", status: 200,
  upstream: null, model: null, inputTokens: null, outputTokens: null, requestBytes: 0,
  responseBytes: 0, durationMs: 1, error: null,
})

async function fixture() {
  const db = new Database(":memory:")
  const repo = new BunSqliteRepo(db)
  initRepo(repo)
  // Synthetic IDs enter the real typed repo only at this fixture boundary.
  const ownerId = "dump_lifetime_owner" as UserId
  const keyId = "dump_lifetime_key" as ApiKeyId
  const token = "ses_dump_lifetime" as SessionToken
  const now = new Date().toISOString()
  await repo.users.create({ id: ownerId, name: "owner", email: "owner@example.invalid", createdAt: now, disabled: false })
  await repo.sessions.create({
    token, userId: ownerId, createdAt: now, authenticatedAt: Date.now(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })
  await repo.apiKeys.save({
    id: keyId, ownerId, name: "lifetime", key: "raw_lifetime", createdAt: now,
    modelMappingsEnabled: false, modelMappings: [], dumpRetentionSeconds: 3600,
  })
  for (let index = 1; index <= 4; index++) {
    await repo.apiKeys.save({
      id: `dump_lifetime_key_${index}` as ApiKeyId, ownerId, name: `lifetime ${index}`, key: `raw_lifetime_${index}`, createdAt: now,
      modelMappingsEnabled: false, modelMappings: [], dumpRetentionSeconds: 3600,
    })
  }
  const store = new SnapshotStore()
  const broker = new ObservedBroker()
  resetDumpRegistryForTests()
  initDumpStore(store)
  initDumpBroker(broker)
  const failures: Error[] = []
  const app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/keys", dumpRoutes)
  app.onError((error, c) => { failures.push(error); return c.text("Internal Server Error", 500) })
  const requests: Array<ReturnType<typeof request>> = []
  function request(options: { aborted?: boolean; authorized?: boolean; key?: string; latest?: boolean } = {}) {
    const controller = new AbortController()
    if (options.aborted) controller.abort()
    const raw = new Request(`http://local.test/api/keys/${options.key ?? keyId}/stream${options.latest ? "?view=latest-v1" : ""}`, {
      signal: controller.signal,
      headers: options.authorized === false ? undefined : { cookie: `session_token=${token}` },
    })
    const add = spyOn(raw.signal, "addEventListener")
    const remove = spyOn(raw.signal, "removeEventListener")
    const response = Promise.resolve(app.fetch(raw))
    const result = { controller, raw, add, remove, response }
    requests.push(result)
    return result
  }
  return {
    store, broker, failures, request,
    async close() {
      for (const request of requests) request.controller.abort()
      store.read.resolve([])
      for (const { iterable } of broker.subscriptions) await iterable[Symbol.asyncIterator]().return?.()
      for (const request of requests) {
        const response = await request.response
        if (response.body && !response.body.locked) await response.body.cancel()
        request.add.mockRestore()
        request.remove.mockRestore()
      }
      resetDumpRegistryForTests()
      db.close()
    },
  }
}

function expectDetached(request: ReturnType<Awaited<ReturnType<typeof fixture>>["request"]>) {
  const added = request.add.mock.calls.filter(([type]) => type === "abort")
  const removed = request.remove.mock.calls.filter(([type]) => type === "abort")
  expect(added).toHaveLength(1)
  expect(removed).toHaveLength(1)
  expect(removed[0]?.[1]).toBe(added[0]?.[1])
}

test("snapshot-window abort synchronously releases the real subscription and suppresses late SSE", async () => {
  const f = await fixture()
  const request = f.request()
  try {
    await f.store.started.promise
    await f.broker.publish("dump_lifetime_key", meta("queued"))
    expect(f.broker.encoded).toBe(1)
    request.controller.abort()
    expect(f.broker.first().signal.aborted).toBe(true)
    expectDetached(request)
    expect(await f.broker.first().iterable[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
    await f.broker.publish("dump_lifetime_key", meta("after-abort"))
    expect(f.broker.encoded).toBe(1)
    f.store.read.resolve([meta("late-snapshot")])
    const response = await request.response
    expect(response.headers.get("Content-Type") ?? "").not.toContain("text/event-stream")
    expect(await response.text()).toBe("")
    expectDetached(request)
  } finally { await f.close() }
})

test("an authorized already-aborted request starts neither subscription nor snapshot", async () => {
  const f = await fixture()
  const request = f.request({ aborted: true })
  // Settle the fixture even against the old implementation, which wrongly reads.
  f.store.read.resolve([])
  try {
    const response = await request.response
    expect(f.broker.subscriptions).toHaveLength(0)
    expect(f.store.reads).toBe(0)
    expect(await response.text()).toBe("")
    expect(request.add.mock.calls).toHaveLength(0)
    expect(request.remove.mock.calls).toHaveLength(0)
  } finally { await f.close() }
})

test("a read rejection after request abort is observed without starting SSE or reporting a live failure", async () => {
  const f = await fixture()
  const request = f.request()
  try {
    await f.store.started.promise
    request.controller.abort()
    f.store.read.reject(new Error("late snapshot failure"))
    const response = await request.response
    expect(await response.text()).toBe("")
    expect(f.failures).toEqual([])
    expect(f.broker.first().signal.aborted).toBe(true)
    expectDetached(request)
  } finally { await f.close() }
})

test("a live snapshot failure retains the original error and releases its subscription and raw listener", async () => {
  const f = await fixture()
  const request = f.request()
  const error = new Error("snapshot unavailable")
  try {
    await f.store.started.promise
    f.store.read.reject(error)
    const response = await request.response
    expect(response.status).toBe(500)
    expect(f.failures).toEqual([error])
    expect(f.broker.first().signal.aborted).toBe(true)
    await f.broker.publish("dump_lifetime_key", meta("after-failure"))
    expect(f.broker.encoded).toBe(0)
    expectDetached(request)
  } finally { await f.close() }
})

test("live delivery keeps snapshot before notifications queued during the read and cleans up on channel close", async () => {
  const f = await fixture()
  const request = f.request()
  try {
    await f.store.started.promise
    expect(f.broker.subscriptions).toHaveLength(1)
    await f.broker.publish("dump_lifetime_key", meta("first"))
    await f.broker.publish("dump_lifetime_key", meta("second"))
    f.store.read.resolve([meta("snapshot")])
    const response = await request.response
    await f.broker.closeChannel("dump_lifetime_key", "test complete")
    const text = await response.text()
    expect(response.headers.get("Content-Type")).toContain("text/event-stream")
    expect(text).toBe(
      `event: snapshot\ndata: ${JSON.stringify({ records: [meta("snapshot")] })}\n\n` +
      `event: appended\ndata: ${JSON.stringify(meta("first"))}\n\n` +
      `event: appended\ndata: ${JSON.stringify(meta("second"))}\n\n`,
    )
    expect(f.broker.first().signal.aborted).toBe(true)
    expectDetached(request)
    request.controller.abort()
    request.controller.abort()
    await f.broker.publish("dump_lifetime_key", meta("retired"))
    expect(f.broker.encoded).toBe(2)
    expectDetached(request)
  } finally { await f.close() }
})

test("abort after snapshot ends a pending live read and repeated cleanup remains inert", async () => {
  const f = await fixture()
  const request = f.request()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    await f.store.started.promise
    f.store.read.resolve([])
    const response = await request.response
    if (!response.body) throw new Error("missing SSE body")
    reader = response.body.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: snapshot\ndata: {"records":[]}\n\n')
    const pending = reader.read()
    request.controller.abort()
    request.controller.abort()
    expect(f.broker.first().signal.aborted).toBe(true)
    expect((await pending).done).toBe(true)
    expectDetached(request)
    await f.broker.publish("dump_lifetime_key", meta("retired"))
    expect(f.broker.encoded).toBe(0)
  } finally {
    await reader?.cancel()
    reader?.releaseLock()
    await f.close()
  }
})

test("already-aborted unauthorized and missing-key requests retain SQLite authorization responses", async () => {
  const f = await fixture()
  try {
    for (const options of [{ authorized: false }, { key: "missing" }]) {
      const request = f.request({ ...options, aborted: true })
      const response = await request.response
      expect(response.status).toBe(options.authorized === false ? 403 : 404)
      expect(f.broker.subscriptions).toHaveLength(0)
      expect(f.store.reads).toBe(0)
      expect(request.add.mock.calls).toHaveLength(0)
    }
  } finally { await f.close() }
})

test("response-body cancellation releases the live subscription without aborting the raw request", async () => {
  const f = await fixture()
  const request = f.request()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    await f.store.started.promise
    f.store.read.resolve([])
    const response = await request.response
    if (!response.body) throw new Error("missing SSE body")
    reader = response.body.getReader()
    expect((await reader.read()).done).toBe(false)
    await reader.cancel()
    expect(request.raw.signal.aborted).toBe(false)
    expect(f.broker.first().signal.aborted).toBe(true)
    await f.broker.publish("dump_lifetime_key", meta("retired"))
    expect(f.broker.encoded).toBe(0)
    expectDetached(request)
  } finally {
    await reader?.cancel()
    reader?.releaseLock()
    await f.close()
  }
})


test("route saturation precedes subscribe/list and abort holds permits until SQL settles", async () => {
  const f = await fixture()
  try {
    const held = Array.from({ length: 4 }, () => f.request())
    await f.store.started.promise
    // Let all four authenticated owners enter their reads.
    await new Promise(resolve => setTimeout(resolve, 0))
    const rejected = await f.request().response
    expect(rejected.status).toBe(429)
    expect(rejected.headers.get("Retry-After")).toBe("5")
    expect(f.store.reads).toBe(4)
    expect(f.broker.subscriptions).toHaveLength(4)
    for (const request of held) request.controller.abort()
    expect((await f.request().response).status).toBe(429)
    f.store.read.resolve([])
    await Promise.all(held.map(request => request.response))
    const fresh = f.request()
    const response = await fresh.response
    expect(response.status).toBe(200)
    fresh.controller.abort()
    await response.body?.cancel()
  } finally { await f.close() }
})

test("SQL-time overflow sends latest reconciliation only; legacy closes without changed shape", async () => {
  for (const latest of [true, false]) {
    const f = await fixture()
    const request = f.request({ latest })
    try {
      await f.store.started.promise
      await f.broker.publish("dump_lifetime_key", { ...meta("oversized"), path: "x".repeat(10000) })
      f.store.read.resolve([meta("snapshot")])
      const response = await request.response
      const text = await response.text()
      expect(text).not.toContain("event: snapshot")
      expect(text).toBe(latest ? 'event: reconciliation_required\ndata: {"reason":"frame_bytes","recovery":"latest_snapshot","completeHistory":false}\n\n' : "")
    } finally { await f.close() }
  }
})

test("latest snapshot exposes omissions and preserves snapshot before append ordering", async () => {
  const f = await fixture()
  const request = f.request({ latest: true })
  try {
    await f.store.started.promise
    await f.broker.publish("dump_lifetime_key", meta("appended"))
    f.store.read.resolve([meta("snapshot"), { ...meta("oversized"), path: "x".repeat(10000) }])
    const response = await request.response
    await f.broker.closeChannel("dump_lifetime_key", "done")
    const text = await response.text()
    expect(text).toBe(`event: snapshot\ndata: ${JSON.stringify({ records: [meta("snapshot")], view: "latest", limit: 100, omittedRows: 1, completeHistory: false, hasMore: false, before: "oversized" })}\n\n` +
      `event: appended\ndata: ${JSON.stringify(meta("appended"))}\n\n`)
  } finally { await f.close() }
})

test("blocked snapshot write owns its permit after raw abort until actual write settlement", async () => {
  const f = await fixture()
  const entered = deferred<void>()
  const settle = deferred<void>()
  const original = SSEStreamingApi.prototype.writeSSE
  const write = spyOn(SSEStreamingApi.prototype, "writeSSE").mockImplementation(async function (message) {
    entered.resolve()
    await settle.promise
    return await original.call(this, message)
  })
  const held = Array.from({ length: 4 }, () => f.request({ latest: true }))
  try {
    await f.store.started.promise
    f.store.read.resolve([])
    const responses = await Promise.all(held.map(request => request.response))
    await entered.promise
    for (const request of held) request.controller.abort()
    expect((await f.request().response).status).toBe(429)
    settle.resolve()
    await Promise.all(responses.map(response => response.text()))
    const fresh = f.request()
    const response = await fresh.response
    expect(response.status).toBe(200)
    fresh.controller.abort()
    await response.body?.cancel()
  } finally {
    settle.resolve()
    write.mockRestore()
    await f.close()
  }
})

test("overflow during blocked snapshot awaits writer then sends one terminal and no append", async () => {
  const f = await fixture()
  const entered = deferred<void>()
  const settle = deferred<void>()
  const original = SSEStreamingApi.prototype.writeSSE
  const events: string[] = []
  const write = spyOn(SSEStreamingApi.prototype, "writeSSE").mockImplementation(async function (message) {
    events.push(message.event ?? "")
    if (message.event === "snapshot") { entered.resolve(); await settle.promise }
    return await original.call(this, message)
  })
  const request = f.request({ latest: true })
  try {
    await f.store.started.promise
    f.store.read.resolve([])
    const response = await request.response
    await entered.promise
    await f.broker.publish("dump_lifetime_key", { ...meta("oversized"), path: "x".repeat(10000) })
    expect(events).toEqual(["snapshot"])
    settle.resolve()
    const text = await response.text()
    expect(events).toEqual(["snapshot", "reconciliation_required"])
    expect(text).not.toContain("event: appended")
  } finally { settle.resolve(); write.mockRestore(); await f.close() }
})


test("overflow during blocked appended write serializes terminal after the admitted write", async () => {
  const f = await fixture()
  const entered = deferred<void>()
  const settle = deferred<void>()
  const original = SSEStreamingApi.prototype.writeSSE
  const events: string[] = []
  const write = spyOn(SSEStreamingApi.prototype, "writeSSE").mockImplementation(async function (message) {
    events.push(message.event ?? "")
    if (message.event === "appended") { entered.resolve(); await settle.promise }
    return await original.call(this, message)
  })
  const request = f.request({ latest: true })
  try {
    await f.store.started.promise
    f.store.read.resolve([])
    const response = await request.response
    const text = response.text()
    await f.broker.publish("dump_lifetime_key", meta("admitted"))
    await entered.promise
    await f.broker.publish("dump_lifetime_key", { ...meta("oversized"), path: "x".repeat(10000) })
    expect(events).toEqual(["snapshot", "appended"])
    settle.resolve()
    expect(await text).toContain("reconciliation_required")
    expect(events).toEqual(["snapshot", "appended", "reconciliation_required"])
  } finally { settle.resolve(); write.mockRestore(); await f.close() }
})

test("overflow between resolved iterator read and route continuation suppresses appended delivery", async () => {
  const f = await fixture()
  const request = f.request({ latest: true })
  try {
    await f.store.started.promise
    f.store.read.resolve([])
    const response = await request.response
    if (!response.body) throw new Error("missing body")
    const reader = response.body.getReader()
    await reader.read()
    f.broker.onDecode = () => queueMicrotask(() => {
      void f.broker.publish("dump_lifetime_key", { ...meta("oversized"), path: "x".repeat(10000) })
    })
    await f.broker.publish("dump_lifetime_key", meta("resolved"))
    const next = new TextDecoder().decode((await reader.read()).value)
    expect(next).toContain("event: reconciliation_required")
    expect(next).not.toContain("event: appended")
    expect((await reader.read()).done).toBe(true)
    reader.releaseLock()
  } finally { await f.close() }
})

test("actual Hono backpressure retains route permits across raw abort until the blocked writer settles", async () => {
  const f = await fixture()
  const snapshotSettled = deferred<void>()
  const appendsStarted = deferred<void>()
  const original = SSEStreamingApi.prototype.writeSSE
  let snapshots = 0
  let started = 0
  let settled = 0
  const write = spyOn(SSEStreamingApi.prototype, "writeSSE").mockImplementation(async function (message) {
    if (message.event === "appended" && ++started === 4) appendsStarted.resolve()
    await original.call(this, message)
    if (message.event === "snapshot" && ++snapshots === 4) snapshotSettled.resolve()
    if (message.event === "appended") settled++
  })
  const held = Array.from({ length: 4 }, () => f.request())
  try {
    await f.store.started.promise
    f.store.read.resolve([])
    const responses = await Promise.all(held.map(request => request.response))
    await snapshotSettled.promise
    await f.broker.publish("dump_lifetime_key", meta("blocked"))
    await appendsStarted.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(0)
    for (const request of held) request.controller.abort()
    expect((await f.request().response).status).toBe(429)
    await Promise.all(responses.map(response => response.text()))
    expect(settled).toBe(4)
    const fresh = f.request()
    const response = await fresh.response
    expect(response.status).toBe(200)
    fresh.controller.abort()
    await response.body?.cancel()
  } finally { write.mockRestore(); await f.close() }
})


test("isolate admission is sixteen authenticated route owners and never overrides auth failures", async () => {
  const f = await fixture()
  try {
    const held = Array.from({ length: 16 }, (_, index) => f.request({
      key: index < 4 ? "dump_lifetime_key" : `dump_lifetime_key_${Math.floor(index / 4)}`,
    }))
    await f.store.started.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    const rejected = await f.request({ key: "dump_lifetime_key_4" }).response
    expect(rejected.status).toBe(429)
    expect(f.store.reads).toBe(16)
    expect(f.broker.subscriptions).toHaveLength(16)
    expect((await f.request({ authorized: false }).response).status).toBe(403)
    expect((await f.request({ key: "missing" }).response).status).toBe(404)
    for (const request of held) request.controller.abort()
    f.store.read.resolve([])
    await Promise.all(held.map(request => request.response))
  } finally { await f.close() }
})


test("all omitted SQL-page rows still expose the older boundary in latest-v1", async () => {
  const f = await fixture()
  const request = f.request({ latest: true })
  try {
    await f.store.started.promise
    f.store.read.resolve(Array.from({ length: 100 }, (_, index) => ({ ...meta(`row-${index}`), path: "x".repeat(10000) })))
    const response = await request.response
    await f.broker.closeChannel("dump_lifetime_key", "done")
    const text = await response.text()
    expect(text).toContain('"records":[]')
    expect(text).toContain('"before":"row-99"')
    expect(text).toContain('"hasMore":true')
    expect(text).toContain('"omittedRows":100')
  } finally { await f.close() }
})


test("an oversized SQL page cursor sends safe capacity terminal instead of a broken snapshot", async () => {
  const f = await fixture()
  const request = f.request({ latest: true })
  try {
    await f.store.started.promise
    const snapshot = Array.from({ length: 100 }, (_, index) => meta(`row-${index}`))
    snapshot[99] = meta("x".repeat(200000))
    f.store.read.resolve(snapshot)
    const response = await request.response
    const text = await response.text()
    expect(text).toBe('event: reconciliation_required\ndata: {"reason":"queue_bytes","recovery":"latest_snapshot","completeHistory":false}\n\n')
    expect(text).not.toContain("snapshot\n")
    await f.broker.publish("dump_lifetime_key", meta("retired"))
    expect(f.broker.encoded).toBe(0)
  } finally { await f.close() }
})
