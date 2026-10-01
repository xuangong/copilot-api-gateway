import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
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

  constructor() {
    super({ encode: value => { this.encoded++; return dumpCodec.encode(value) }, decode: dumpCodec.decode })
  }

  override subscribe(channelId: string, signal: AbortSignal): AsyncIterable<DumpMetadata> {
    const iterable = super.subscribe(channelId, signal)
    this.subscriptions.push({ signal, iterable })
    return iterable
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
  function request(options: { aborted?: boolean; authorized?: boolean; key?: string } = {}) {
    const controller = new AbortController()
    if (options.aborted) controller.abort()
    const raw = new Request(`http://local.test/api/keys/${options.key ?? keyId}/stream`, {
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
