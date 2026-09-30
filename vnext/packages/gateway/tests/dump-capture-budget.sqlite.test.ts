import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FileProvider } from "@vibe-core/platform"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { FsFileProvider } from "@vibe-llm/platform-bun/src/fs-file-provider.ts"
import { initRepo } from "../src/repo/index.ts"
import type { ApiKeyId, UpstreamId } from "../src/repo/branded-ids.ts"
import type { ApiKey } from "../src/repo/types.ts"
import { FileDumpStore } from "../src/repo/dump-store.ts"
import { DumpAccumulator } from "../src/shared/dump/accumulator.ts"
import { DumpCaptureBudget } from "../src/shared/dump/capture-budget.ts"
import { dumpRecordToExport } from "../src/shared/dump/export.ts"
import { dumpRecordToWire } from "../src/shared/dump/wire.ts"
import { initDumpBroker, initDumpStore, resetDumpRegistryForTests } from "../src/shared/dump/registry.ts"
import type { DumpMetadata, PreparedDumpRequestBody } from "../src/shared/dump/types.ts"
import { EventTargetChannelBroker } from "../src/shared/runtime/event-target-channel-broker.ts"
import { dumpCodec } from "../src/shared/dump/codec.ts"

const keyId = "capture-budget-key" as ApiKeyId
const upstreamId = "capture-budget-upstream" as UpstreamId
const key: ApiKey = { id: keyId, name: "test", key: "capture-budget-secret", createdAt: "2026-09-30", dumpRetentionSeconds: 86400,
  modelMappingsEnabled: false, modelMappings: [] }
let directory: string, raw: Database, db: BunSqliteDatabase, repo: BunSqliteRepo, files: FsFileProvider, store: FileDumpStore
let broker: EventTargetChannelBroker<DumpMetadata>
let pending: Promise<unknown>[]
const gate = () => Promise.withResolvers<void>()
const present = <T>(value: T | null | undefined): T => { if (value == null) throw new Error("Missing fixture"); return value }

beforeEach(async () => {
  resetDumpRegistryForTests()
  directory = await mkdtemp(join(tmpdir(), "dump-capture-budget-"))
  raw = new Database(join(directory, "test.sqlite"))
  repo = new BunSqliteRepo(raw)
  db = new BunSqliteDatabase(raw)
  files = new FsFileProvider(join(directory, "files"))
  store = new FileDumpStore(db, files)
  broker = new EventTargetChannelBroker(dumpCodec)
  pending = []
  await repo.apiKeys.save(key)
  await repo.upstreams.save({ id: upstreamId, name: "fixture", provider: "custom", enabled: true, sortOrder: 0,
    config: {}, flagOverrides: {}, disabledPublicModelIds: [], createdAt: key.createdAt, updatedAt: key.createdAt })
  initRepo(repo)
  initDumpStore(store)
  initDumpBroker(broker)
})

afterEach(async () => {
  await Promise.allSettled(pending)
  resetDumpRegistryForTests()
  raw.close()
  await rm(directory, { recursive: true, force: true })
})

function accumulator(budget = new DumpCaptureBudget(), body = "request") {
  const bytes = new TextEncoder().encode(body)
  return new DumpAccumulator(key, { method: "POST", path: "/v1/responses", headers: [], bodyByteLength: bytes.byteLength, streamError: null },
    bytes, Date.now(), { waitUntil: work => { pending.push(work) } }, budget)
}

test("oversized requests omit diagnostics visibly without starting request compression", async () => {
  const preparation = spyOn(store, "prepareRequestBody")
  const budget = new DumpCaptureBudget({ captureBytes: 1000 })
  const acc = accumulator(budget, "x".repeat(1000))
  acc.recordSentPayloadBytes(7)
  await acc.finalizeTurn(200, [], { answer: "success" })
  const row = present(await store.get(keyId, acc.recordId))
  expect(preparation).toHaveBeenCalledTimes(0)
  expect(row.meta).toMatchObject({ status: 200, error: null, requestBytes: 1000, responseBytes: 7,
    capture: { state: "omitted", reason: "capture_limit" } })
  expect(row.request.body.byteLength).toBe(0)
  expect(row.response.body).toEqual({ type: "none" })
  expect(dumpRecordToWire(row).meta.capture).toEqual(row.meta.capture)
  expect(dumpRecordToExport(row).meta.capture).toEqual(row.meta.capture)
  expect(budget.retainedBytes).toBe(0)
})

test("frame overflow removes the entire captured payload while canonical client bytes stay exact", async () => {
  const budget = new DumpCaptureBudget({ frames: 1 })
  const acc = accumulator(budget)
  acc.frame({ type: "event", event: { text: "first" } })
  acc.frame({ type: "event", event: { text: "over budget" } })
  const client = acc.finalize(new Response("unchanged client body", { status: 201 }), { settled: Promise.resolve() })
  expect(client.status).toBe(201)
  expect(await client.text()).toBe("unchanged client body")
  await Promise.all(pending)
  const row = present(await store.get(keyId, acc.recordId))
  expect(row.meta).toMatchObject({ status: 201, error: null, responseBytes: 21, capture: { state: "omitted", reason: "frame_limit" } })
  expect(row.request.body.byteLength).toBe(0)
  expect(row.response.body).toEqual({ type: "none" })
  expect(budget.retainedBytes).toBe(0)
})

test("oversized single frames, canonical fallback strings and legacy bytes all omit complete bodies", async () => {
  for (const mode of ["frame", "canonical", "legacy"] as const) {
    const budget = new DumpCaptureBudget({ captureBytes: 1000 })
    const acc = accumulator(budget)
    const payload = "x".repeat(2000)
    if (mode === "frame") acc.frame({ type: "event", event: { text: payload } })
    const response = new Response(payload, { status: 202 })
    const client = mode === "legacy" ? acc.finalize(response) : acc.finalize(response, {
      settled: Promise.resolve(), fallbackBody: mode === "canonical" ? payload : undefined,
    })
    expect(await client.text()).toBe(payload)
    await Promise.all(pending.splice(0))
    const stored = present(await store.get(keyId, acc.recordId))
    expect(stored.meta).toMatchObject({ status: 202, error: null, responseBytes: 2000, capture: { state: "omitted", reason: "capture_limit" } })
    expect(stored.response.body).toEqual({ type: "none" })
    expect(stored.request.body.byteLength).toBe(0)
    expect(budget.retainedBytes).toBe(0)
  }
})

test("ordinary frame projection is exact and independent of later caller mutation", async () => {
  const budget = new DumpCaptureBudget()
  const acc = accumulator(budget)
  const event = { text: "first", nested: [1, null, "string"] }
  Object.defineProperty(event, "private", { value: new Uint8Array(1_000_000) })
  acc.frame({ type: "event", event })
  event.text = "later"
  await acc.finalizeTurn(200, [])
  const stored = present(await store.get(keyId, acc.recordId))
  expect(stored.meta.capture).toBeUndefined()
  expect(stored.request.body).toEqual(new TextEncoder().encode("request"))
  if (stored.response.body.type !== "stream") throw new Error("Expected canonical stream")
  expect(stored.response.body.events[0]?.frame).toEqual({ type: "event", event: { text: "first", nested: [1, null, "string"] } })
  expect(budget.retainedBytes).toBe(0)
})

test("unsupported custom fallback serialization writes an omission record without invoking it", async () => {
  const budget = new DumpCaptureBudget()
  const acc = accumulator(budget)
  let invoked = false
  const body = Object.defineProperty({}, "toJSON", { value: () => { invoked = true; return { ok: true } } })
  await acc.finalizeTurn(200, [], body)
  const stored = present(await store.get(keyId, acc.recordId))
  expect(stored.meta).toMatchObject({ status: 200, error: null, capture: { state: "omitted", reason: "unsupported_payload" } })
  expect(stored.response.body).toEqual({ type: "none" })
  expect(invoked).toBe(false)
  expect(budget.retainedBytes).toBe(0)
})

test("environment reservation lasts through preparation, file upload and broker publication", async () => {
  const prepareEntered = gate(), prepareRelease = gate(), putEntered = gate(), putRelease = gate(), publishEntered = gate(), publishRelease = gate()
  const heldFiles: FileProvider = {
    async put(path, body, options) { putEntered.resolve(); await putRelease.promise; await files.put(path, body, options) },
    get: files.get.bind(files), delete: files.delete.bind(files),
  }
  class HeldStore extends FileDumpStore {
    override async prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody> {
      prepareEntered.resolve(); await prepareRelease.promise; return super.prepareRequestBody(body)
    }
  }
  initDumpStore(new HeldStore(db, heldFiles))
  initDumpBroker({ async publish(id, meta) { publishEntered.resolve(); await publishRelease.promise; await broker.publish(id, meta) },
    subscribe: broker.subscribe.bind(broker), closeChannel: broker.closeChannel.bind(broker) })
  const budget = new DumpCaptureBudget({ captureBytes: 1000, environmentBytes: 1000 })
  const acc = accumulator(budget, "x".repeat(200))
  const writing = acc.finalizeTurn(200, [])
  try {
    await prepareEntered.promise
    const reserved = budget.retainedBytes
    expect(reserved).toBeGreaterThan(600)
    const overflow = accumulator(budget, "y".repeat(200))
    const omitted = overflow.finalizeTurn(200, [])
    prepareRelease.resolve()
    await putEntered.promise
    expect(budget.retainedBytes).toBe(reserved)
    putRelease.resolve()
    await publishEntered.promise
    expect(budget.retainedBytes).toBe(reserved)
    expect(acc.finalizeTurn(500, [])).toBe(writing)
    publishRelease.resolve()
    await Promise.all([writing, omitted])
    expect((await store.get(keyId, overflow.recordId))?.meta.capture?.reason).toBe("environment_limit")
    expect(budget.retainedBytes).toBe(0)
  } finally { prepareRelease.resolve(); putRelease.resolve(); publishRelease.resolve(); await writing }
})

for (const failure of ["lookup", "serialization"] as const) test(`${failure} failure retains accounting until in-flight request preparation settles`, async () => {
  const entered = gate(), release = gate()
  class HeldStore extends FileDumpStore {
    override async prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody> {
      entered.resolve(); await release.promise; return super.prepareRequestBody(body)
    }
  }
  initDumpStore(new HeldStore(db, files))
  const budget = new DumpCaptureBudget()
  const acc = accumulator(budget)
  if (failure === "lookup") {
    acc.success({ upstream: upstreamId, model: "fixture" }, null)
    raw.exec("ALTER TABLE upstreams RENAME TO unavailable_upstreams")
  }
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const writing = acc.finalizeTurn(200, [], failure === "serialization" ? cyclic : { ok: true })
  const outcome = writing.then(() => null, error => error as unknown)
  try {
    await entered.promise
    expect(budget.retainedBytes).toBeGreaterThan(0)
  } finally { release.resolve() }
  expect(await outcome).toBeInstanceOf(Error)
  expect(budget.retainedBytes).toBe(0)
  expect(raw.query("SELECT id FROM dump_records").all()).toEqual([])
})

test("cancellation releases after preparation and persistence without waiting for semantic completion", async () => {
  const entered = gate(), release = gate()
  class HeldStore extends FileDumpStore {
    override async prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody> {
      entered.resolve(); await release.promise; return super.prepareRequestBody(body)
    }
  }
  initDumpStore(new HeldStore(db, files))
  const budget = new DumpCaptureBudget()
  const acc = accumulator(budget)
  const client = acc.finalize(new Response("body"), { settled: new Promise<void>(() => {}) })
  await client.body?.cancel()
  try { await entered.promise; expect(budget.retainedBytes).toBeGreaterThan(0) }
  finally { release.resolve(); await Promise.all(pending) }
  expect((await store.get(keyId, acc.recordId))?.meta.error?.kind).toBe("cancelled")
  expect(budget.retainedBytes).toBe(0)
})

for (const failure of ["put", "publish", "prepare"] as const) test(`${failure} rejection releases capture accounting exactly once`, async () => {
  const budget = new DumpCaptureBudget()
  if (failure === "put") raw.exec("CREATE TRIGGER reject_dump BEFORE INSERT ON dump_records BEGIN SELECT RAISE(ABORT, 'rejected'); END")
  if (failure === "publish") initDumpBroker({ async publish() { throw new Error("publish failed") },
    subscribe: broker.subscribe.bind(broker), closeChannel: broker.closeChannel.bind(broker) })
  if (failure === "prepare") {
    class RejectingStore extends FileDumpStore { override prepareRequestBody(): Promise<PreparedDumpRequestBody> { return Promise.reject(new Error("prepare failed")) } }
    initDumpStore(new RejectingStore(db, files))
  }
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    const acc = accumulator(budget)
    const writing = acc.finalizeTurn(200, [], { ok: true })
    expect(acc.finalizeTurn(500, [])).toBe(writing)
    await writing
    expect(budget.retainedBytes).toBe(0)
    expect(log).toHaveBeenCalledTimes(1)
  } finally { log.mockRestore() }
})
