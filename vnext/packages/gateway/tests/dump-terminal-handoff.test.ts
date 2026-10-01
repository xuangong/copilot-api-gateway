import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetPlatformForTests, initBackground, withBackground, type FileProvider } from "@vibe-core/platform"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { FsFileProvider } from "@vibe-llm/platform-bun/src/fs-file-provider.ts"
import { initRepo } from "../src/repo/index.ts"
import type { ApiKeyId, UpstreamId } from "../src/repo/branded-ids.ts"
import type { ApiKey } from "../src/repo/types.ts"
import { FileDumpStore } from "../src/repo/dump-store.ts"
import { DumpAccumulator, openTransportDump } from "../src/shared/dump/accumulator.ts"
import { dumpCodec } from "../src/shared/dump/codec.ts"
import { initDumpBroker, initDumpStore, resetDumpRegistryForTests } from "../src/shared/dump/registry.ts"
import type { DumpMetadata, PreparedDumpRequestBody } from "../src/shared/dump/types.ts"
import { UpstreamExchangeCollector } from "../src/shared/dump/upstream-attempts.ts"
import { EventTargetChannelBroker } from "../src/shared/runtime/event-target-channel-broker.ts"

const keyId = "terminal-handoff-key" as ApiKeyId
const upstreamId = "terminal-handoff-upstream" as UpstreamId
const key: ApiKey = {
  id: keyId, name: "test", key: "synthetic-terminal-handoff", createdAt: "2026-09-30",
  modelMappingsEnabled: false, modelMappings: [], dumpRetentionSeconds: 86400,
}
let root: string
let raw: Database
let repo: BunSqliteRepo
let db: BunSqliteDatabase
let files: FsFileProvider
let store: FileDumpStore
let broker: EventTargetChannelBroker<DumpMetadata>
let background: Promise<unknown>[]

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, resolve }
}

function waitAt(entered: ReturnType<typeof gate>, completion: Promise<unknown>): Promise<void> {
  return Promise.race([entered.promise, completion.then(() => { throw new Error("write settled before reaching the barrier") })])
}

beforeEach(async () => {
  __resetPlatformForTests()
  resetDumpRegistryForTests()
  root = await mkdtemp(join(tmpdir(), "dump-terminal-handoff-"))
  raw = new Database(join(root, "test.sqlite"))
  repo = new BunSqliteRepo(raw)
  db = new BunSqliteDatabase(raw)
  files = new FsFileProvider(join(root, "files"))
  store = new FileDumpStore(db, files)
  broker = new EventTargetChannelBroker(dumpCodec)
  background = []
  initBackground({ waitUntil: promise => { background.push(promise) } })
  await repo.apiKeys.save(key)
  await repo.upstreams.save({
    id: upstreamId, provider: "custom", name: "test", enabled: true, sortOrder: 0,
    config: {}, flagOverrides: {}, disabledPublicModelIds: [], createdAt: key.createdAt, updatedAt: key.createdAt,
  })
  initRepo(repo)
  initDumpStore(store)
  initDumpBroker(broker)
})

afterEach(async () => {
  await Promise.allSettled(background)
  __resetPlatformForTests()
  resetDumpRegistryForTests()
  raw.close()
  await rm(root, { recursive: true, force: true })
})

function accumulator() {
  const bytes = new TextEncoder().encode("request bytes")
  return new DumpAccumulator(key, {
    method: "POST", path: "/v1/responses", headers: [["content-type", "application/json"]],
    bodyByteLength: bytes.byteLength, streamError: null,
  }, bytes, Date.now())
}

function holdUploads() {
  const entered = gate(), release = gate()
  const held: FileProvider = {
    async put(path, body, options) {
      entered.resolve()
      await release.promise
      await files.put(path, body, options)
    },
    get: files.get.bind(files), delete: files.delete.bind(files),
  }
  initDumpStore(new FileDumpStore(db, held))
  return { entered, release }
}

function beginAttempt(acc: DumpAccumulator) {
  return acc.upstreamDialObservation().forOperation({ upstreamId, operation: "responses.create" })
    .beginCall({ upstreamId, url: "http://fixture.invalid", startedAt: Date.now() })?.beginAttempt?.({
      transport: "direct_fetch", transportId: "direct", method: "POST", url: "http://fixture.invalid",
      requestHeaders: undefined, body: { kind: "text", text: "captured request" }, startedAt: Date.now(),
    })
}

for (const mode of ["status", "tee", "canonical", "cancel"] as const) {
  test(`${mode} dump finalization retains the executor captured at construction`, async () => {
    const origin = { pending: [] as Promise<unknown>[], waitUntil(work: Promise<unknown>) { this.pending.push(work); background.push(work) } }
    const consumer = { pending: [] as Promise<unknown>[], waitUntil(work: Promise<unknown>) { this.pending.push(work); background.push(work) } }
    const acc = withBackground(origin, accumulator)
    await withBackground(consumer, async () => {
      if (mode === "status") acc.finalize(201, [])
      else if (mode === "tee") await acc.finalize(new Response("answer", { status: 201 })).text()
      else {
        const response = acc.finalize(new Response("answer", { status: 201 }), {
          settled: mode === "cancel" ? new Promise<void>(() => {}) : Promise.resolve(),
          fallbackBody: "answer",
        })
        if (mode === "cancel") await response.body?.cancel()
        else await response.text()
      }
    })
    await Promise.all(background)
    expect(origin.pending).toHaveLength(mode === "cancel" ? 2 : 1)
    expect(consumer.pending).toHaveLength(0)
    const stored = await store.get(keyId, acc.recordId)
    expect(stored?.meta.status).toBe(201)
    if (mode === "cancel") expect(stored?.meta.error?.kind).toBe("cancelled")
    expect(raw.query("SELECT id FROM dump_records").all()).toHaveLength(1)
  })
}

test("disabled transport dumps need neither a scheduler nor initialized storage", () => {
  __resetPlatformForTests()
  resetDumpRegistryForTests()
  expect(openTransportDump({ method: "WS", path: "/v1/responses", headers: new Headers() },
    { ...key, dumpRetentionSeconds: null }, { bytes: new Uint8Array(), streamError: null })).toBeNull()
})

test("zero retention transport dumps remain enabled with an explicit executor", async () => {
  const origin = { pending: [] as Promise<unknown>[], waitUntil(work: Promise<unknown>) { this.pending.push(work); background.push(work) } }
  const acc = openTransportDump({ method: "WS", path: "/v1/responses", headers: new Headers() },
    { ...key, dumpRetentionSeconds: 0 }, { bytes: new Uint8Array(), streamError: null }, origin)
  if (!acc) throw new Error("zero retention dump expected")
  acc.finalize(201, [])
  await Promise.all(background)
  expect(origin.pending).toHaveLength(1)
  expect((await store.get(keyId, acc.recordId))?.meta.method).toBe("WS")
})

test("terminal handoff seals frame capture but reads scalar metadata after the upstream lookup", async () => {
  const entered = gate(), release = gate()
  const uploads = holdUploads()
  const read = repo.upstreams.getById.bind(repo.upstreams)
  repo.upstreams.getById = async <TState>(id: UpstreamId) => {
    const result = await read<TState>(id)
    entered.resolve()
    await release.promise
    return result
  }
  const acc = accumulator()
  acc.frame({ type: "event", event: { text: "first" } })
  acc.success({ model: "initial", upstream: upstreamId }, { input: 1, output: 2 })
  const writing = acc.finalizeTurn(200, [])
  try {
    await waitAt(entered, writing)
    acc.frame({ type: "event", event: { text: "after terminal" } })
    acc.requestedModel("updated")
    acc.success({ model: "resolved", upstream: upstreamId }, { input: 3, input_cache_read: 4, output: 5 })
    acc.cancelled()
    release.resolve()
    await waitAt(uploads.entered, writing)
    acc.requestedModel("after snapshot")
    acc.success({ model: "too late", upstream: upstreamId }, { input: 50, output: 60 })
    acc.error("gateway")
  } finally { release.resolve(); uploads.release.resolve(); await writing }
  const stored = await store.get(keyId, acc.recordId)
  expect(stored?.meta).toMatchObject({ model: "updated", inputTokens: 7, outputTokens: 5, error: { kind: "cancelled" } })
  expect(stored?.response.body.type).toBe("stream")
  if (stored?.response.body.type !== "stream") throw new Error("expected canonical stream")
  expect(stored.response.body.events.map(event => event.frame)).toEqual([{ type: "event", event: { text: "first" } }])
  expect(stored.request.body).toEqual(new TextEncoder().encode("request bytes"))
})

test("repeated terminal calls share completion and publish only the first record", async () => {
  const held = holdUploads()
  let publications = 0
  initDumpBroker({
    async publish(id, meta) { publications++; await broker.publish(id, meta) },
    subscribe: broker.subscribe.bind(broker), closeChannel: broker.closeChannel.bind(broker),
  })
  const acc = accumulator()
  const first = acc.finalizeTurn(201, [], { answer: "first" })
  const second = acc.finalizeTurn(500, [], { answer: "second" })
  // Handle both outcomes even when the pre-fix implementation duplicates the write.
  const completions = Promise.all([first, second])
  try {
    await waitAt(held.entered, completions)
    expect(second).toBe(first)
    expect(publications).toBe(0)
    acc.finalize(503, [])
  } finally { held.release.resolve(); await completions; await Promise.all(background) }
  expect(publications).toBe(1)
  const stored = await store.get(keyId, acc.recordId)
  expect(stored?.meta.status).toBe(201)
  expect(stored?.response.body).toEqual({ type: "bytes", body: new TextEncoder().encode('{"answer":"first"}') })
  expect(raw.query("SELECT id FROM dump_records").all()).toHaveLength(1)
  expect(raw.query("SELECT file_key FROM spilled_files").all()).toHaveLength(2)
})

test("late lazy observation and collector attachment cannot reopen completed capture", async () => {
  const held = holdUploads()
  const acc = accumulator()
  const writing = acc.finalizeTurn(200, [], { answer: "done" })
  const borrowed = new UpstreamExchangeCollector()
  try {
    await waitAt(held.entered, writing)
    acc.attachUpstreamExchangeCollector(borrowed)
    expect(beginAttempt(acc)).toBeUndefined()
  } finally { held.release.resolve(); await writing }
  expect(borrowed.finish().attempts).toEqual([])
  expect((await store.get(keyId, acc.recordId))?.upstreamExchanges).toBeNull()
})

test("borrowed collector retains ordinary finish identity after terminal persistence", async () => {
  const acc = accumulator()
  const borrowed = new UpstreamExchangeCollector()
  const attempt = borrowed.begin({ parentCallId: "call", upstreamId, operation: "responses.create", method: "POST" })
  if (!attempt) throw new Error("expected capture")
  attempt.observePreparedText("borrowed bytes")
  const original = borrowed.finish()
  acc.attachUpstreamExchangeCollector(borrowed)
  await acc.finalizeTurn(200, [], { answer: "done" })
  expect(borrowed.finish()).toBe(original)
  expect((await store.get(keyId, acc.recordId))?.upstreamExchanges).toEqual(original)
})

test("upstream lookup SQL failure rejects instead of becoming a best-effort storage failure", async () => {
  const acc = accumulator()
  acc.success({ model: "model", upstream: upstreamId }, null)
  raw.exec("ALTER TABLE upstreams RENAME TO unavailable_upstreams")
  await expect(acc.finalizeTurn(200, [], { answer: "done" })).rejects.toThrow("upstreams")
  expect(raw.query("SELECT id FROM dump_records").all()).toEqual([])
  expect(raw.query("SELECT file_key FROM spilled_files").all()).toEqual([])
})

test("fallback serialization stays an asynchronous rejection before storage starts", async () => {
  const acc = accumulator()
  const body: Record<string, unknown> = {}
  body.self = body
  let completion: Promise<void> | undefined
  expect(() => { completion = acc.finalizeTurn(200, [], body) }).not.toThrow()
  if (!completion) throw new Error("expected rejected completion")
  await expect(completion).rejects.toThrow()
  const repeated = acc.finalizeTurn(200, [], { answer: "later" })
  try { expect(repeated).toBe(completion) }
  finally { await Promise.allSettled([repeated]) }
  expect(beginAttempt(acc)).toBeUndefined()
  acc.finalize(204, [])
  expect(await acc.finalize(new Response("later client body")).text()).toBe("later client body")
  expect(raw.query("SELECT id FROM dump_records").all()).toEqual([])
  expect(raw.query("SELECT file_key FROM spilled_files").all()).toEqual([])
})

test("eager request preparation failure is best effort and never stages files", async () => {
  class FailingPreparationStore extends FileDumpStore {
    override prepareRequestBody(): Promise<PreparedDumpRequestBody> { return Promise.reject(new Error("preparation failed")) }
  }
  initDumpStore(new FailingPreparationStore(db, files))
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    const acc = accumulator()
    await Promise.resolve()
    await expect(acc.finalizeTurn(200, [], { answer: "done" })).resolves.toBeUndefined()
    expect(raw.query("SELECT id FROM dump_records").all()).toEqual([])
    expect(raw.query("SELECT file_key FROM spilled_files").all()).toEqual([])
    expect(log).toHaveBeenCalledTimes(1)
  } finally { log.mockRestore() }
})

test("broker rejection follows a committed dump and does not retry persistence", async () => {
  let publications = 0
  initDumpBroker({
    async publish(id, meta) {
      await broker.publish(id, meta)
      publications++
      throw new Error("broker rejected")
    },
    subscribe: broker.subscribe.bind(broker), closeChannel: broker.closeChannel.bind(broker),
  })
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    const acc = accumulator()
    await expect(acc.finalizeTurn(200, [], { answer: "done" })).resolves.toBeUndefined()
    expect(publications).toBe(1)
    expect(await store.get(keyId, acc.recordId)).not.toBeNull()
    expect(raw.query("SELECT state FROM spilled_files").all()).toEqual([{ state: "owned" }, { state: "owned" }])
    expect(log).toHaveBeenCalledTimes(1)
  } finally { log.mockRestore() }
})

test("HTTP finalization keeps frames arriving during tee drain and ignores a second terminal input", async () => {
  const controller = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
  const body = new ReadableStream<Uint8Array>({ start(value) { controller.resolve(value) } })
  const source = await controller.promise
  const acc = accumulator()
  let closed = false
  try {
    const client = acc.finalize(new Response(body, { status: 202 }))
    const duplicate = acc.finalize(new Response("second input", { status: 203 }))
    expect(await duplicate.text()).toBe("second input")
    acc.frame({ type: "event", event: { text: "during drain" } })
    source.enqueue(new TextEncoder().encode("first input"))
    source.close()
    closed = true
    expect(await client.text()).toBe("first input")
  } finally {
    if (!closed) source.close()
    await Promise.allSettled(background)
  }
  const stored = await store.get(keyId, acc.recordId)
  expect(stored?.meta.status).toBe(202)
  expect(stored?.response.body.type).toBe("stream")
  if (stored?.response.body.type !== "stream") throw new Error("expected canonical stream")
  expect(stored.response.body.events.map(event => event.frame)).toEqual([{ type: "event", event: { text: "during drain" } }])
  expect(raw.query("SELECT file_key FROM spilled_files").all()).toHaveLength(2)
})

for (const subscribed of [false, true]) {
  test(`dump persistence precedes optional notification encoding with subscribed=${subscribed}`, async () => {
    let encoded = 0
    let persistedAtEncode: { records: unknown[], files: unknown[] } | undefined
    broker = new EventTargetChannelBroker<DumpMetadata>({
      encode(meta) {
        encoded++
        persistedAtEncode = {
          records: raw.query("SELECT id FROM dump_records").all(),
          files: raw.query("SELECT state FROM spilled_files").all(),
        }
        return dumpCodec.encode(meta)
      },
      decode: dumpCodec.decode,
    })
    initDumpBroker(broker)
    const ac = new AbortController()
    const iterator = subscribed ? broker.subscribe(keyId, ac.signal)[Symbol.asyncIterator]() : undefined
    try {
      const acc = accumulator()
      await acc.finalizeTurn(200, [], { answer: "persisted" })
      expect(encoded).toBe(subscribed ? 1 : 0)
      expect(persistedAtEncode).toEqual(subscribed ? {
        records: [{ id: acc.recordId }],
        files: [{ state: "owned" }, { state: "owned" }],
      } : undefined)
      expect((await store.get(keyId, acc.recordId))?.meta.status).toBe(200)
      if (iterator) expect((await iterator.next()).value.id).toBe(acc.recordId)
    } finally { ac.abort() }
  })
}
