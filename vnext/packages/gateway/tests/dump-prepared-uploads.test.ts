import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { FsFileProvider } from "@vibe-llm/platform-bun/src/fs-file-provider.ts"
import type { FileProvider } from "@vibe-core/platform"
import { FileDumpStore } from "../src/repo/dump-store.ts"
import { UpstreamExchangeCollector } from "../src/shared/dump/upstream-attempts.ts"
import type { DumpWriteRecord } from "../src/shared/dump/types.ts"
import type { ApiKeyId, DumpRecordId } from "../src/repo/branded-ids.ts"
import { collectDumpFiles } from "../src/repo/dump-maintenance.ts"

let root: string
let raw: Database
let db: BunSqliteDatabase
let realFiles: FsFileProvider
const keyId = "prepared-upload-key" as ApiKeyId
const recordId = "prepared-upload-record" as DumpRecordId

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dump-prepared-uploads-"))
  raw = new Database(join(root, "test.sqlite"))
  new BunSqliteRepo(raw)
  db = new BunSqliteDatabase(raw)
  realFiles = new FsFileProvider(join(root, "files"))
  raw.run("INSERT INTO api_keys (id, name, key, created_at, dump_retention_seconds) VALUES (?, 'test', 'test-key', '2026-09-29', 3600)", [keyId])
})
afterEach(async () => { raw.close(); await rm(root, { recursive: true, force: true }) })

function record(exchanges: DumpWriteRecord["upstreamExchanges"]): DumpWriteRecord {
  const now = Date.now()
  return {
    meta: {
      id: recordId, startedAt: now - 1, completedAt: now, method: "POST", path: "/v1/responses",
      status: 200, upstream: null, model: null, inputTokens: null, outputTokens: null,
      requestBytes: 1, responseBytes: 1, durationMs: 1, error: null,
    },
    request: { method: "POST", path: "/v1/responses", headers: [], body: { encoding: "identity", bytes: Uint8Array.of(1), decodedByteLength: 1 } },
    response: { status: 200, headers: [], body: { type: "bytes", body: Uint8Array.of(2) } },
    upstreamExchanges: exchanges,
  }
}

function snapshot() {
  const collector = new UpstreamExchangeCollector()
  return collector.finish()
}

function descriptor(): string | null {
  return raw.query<{ upstream_exchanges_descriptor: string | null }, []>("SELECT upstream_exchanges_descriptor FROM dump_records").get()?.upstream_exchanges_descriptor ?? null
}

const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
type Side = "req" | "resp" | "up"
const sideOf = (key: string): Side => key.endsWith(".req.gz") ? "req" : key.endsWith(".resp.gz") ? "resp" : "up"
const states = () => raw.query<{ state: string }, []>("SELECT state FROM spilled_files ORDER BY owner_kind").all().map(row => row.state)
const rowCount = () => raw.query("SELECT id FROM dump_records").all().length

test("prepared uploads overlap with a fixed three-write bound and commit after the last write", async () => {
  const gates = { req: gate(), resp: gate(), up: gate() }
  const done = { req: gate(), resp: gate(), up: gate() }
  const first = gate(), started: Side[] = []
  let active = 0, maximum = 0
  const prepared = await new FileDumpStore(db, realFiles).prepareRequestBody(Uint8Array.of(1))
  const files: FileProvider = {
    async put(key, body, options) {
      const side = sideOf(key)
      expect(states()).toEqual(["staged", "staged", "staged"])
      expect(rowCount()).toBe(0)
      if (side === "req") expect(body).toBe(prepared.bytes)
      started.push(side)
      active++; maximum = Math.max(maximum, active)
      first.resolve()
      try { await gates[side].promise; await realFiles.put(key, body, options) }
      finally { active--; done[side].resolve() }
    },
    get: realFiles.get.bind(realFiles), delete: realFiles.delete.bind(realFiles),
  }
  const store = new FileDumpStore(db, files)
  const input = record(snapshot())
  input.request.body = prepared
  const writing = store.put(keyId, input)
  try {
    await first.promise
    expect(started.toSorted()).toEqual(["req", "resp", "up"])
    expect(maximum).toBe(3)
    gates.up.resolve(); await done.up.promise
    expect(rowCount()).toBe(0)
    gates.req.resolve(); await done.req.promise
    expect(rowCount()).toBe(0)
  } finally { for (const item of Object.values(gates)) item.resolve(); await writing }
  expect(states()).toEqual(["owned", "owned", "owned"])
  const stored = await store.get(keyId, recordId)
  expect(stored?.request.body).toEqual(Uint8Array.of(1))
  expect(stored?.response.body).toEqual({ type: "bytes", body: Uint8Array.of(2) })
  expect(stored?.upstreamExchanges?.attempts).toEqual([])
})

test.each(["req", "resp"] as const)("early %s failure waits for every sibling before collective retirement", async failedSide => {
  const release = gate(), first = gate(), started: Side[] = []
  const files: FileProvider = {
    async put(key, body, options) {
      const side = sideOf(key)
      started.push(side); first.resolve()
      if (side === failedSide) throw new Error(`core ${side} failure`)
      await release.promise
      await realFiles.put(key, body, options)
      if (side === "up") throw new Error("late partial sidecar put")
    },
    get: realFiles.get.bind(realFiles), delete: realFiles.delete.bind(realFiles),
  }
  let settled = false
  const writing = new FileDumpStore(db, files).put(keyId, record(snapshot())).then(
    () => { settled = true; return null }, error => { settled = true; return error as Error },
  )
  try {
    await first.promise
    expect(started.toSorted()).toEqual(["req", "resp", "up"])
    await Bun.sleep(0)
    expect(settled).toBe(false)
    expect(rowCount()).toBe(0)
    expect(states()).toEqual(["staged", "staged", "staged"])
  } finally { release.resolve(); await writing }
  expect((await writing)?.message).toBe(`core ${failedSide} failure`)
  expect(rowCount()).toBe(0)
  expect(states()).toEqual(["retired", "retired", "retired"])
  expect(await collectDumpFiles(db, realFiles, Date.now() + 1)).toBe(3)
})

test("early optional rejection waits for both core writes and retires only the sidecar", async () => {
  const release = gate(), first = gate(), started: Side[] = []
  const files: FileProvider = {
    async put(key, body, options) {
      const side = sideOf(key)
      started.push(side); first.resolve()
      if (side === "up") throw new Error("optional unavailable")
      await release.promise
      await realFiles.put(key, body, options)
    },
    get: realFiles.get.bind(realFiles), delete: realFiles.delete.bind(realFiles),
  }
  const store = new FileDumpStore(db, files)
  let settled = false
  const writing = store.put(keyId, record(snapshot())).finally(() => { settled = true })
  try {
    await first.promise
    expect(started.toSorted()).toEqual(["req", "resp", "up"])
    await Bun.sleep(0)
    expect(settled).toBe(false)
    expect(rowCount()).toBe(0)
    expect(states()).toEqual(["staged", "staged", "staged"])
  } finally { release.resolve(); await writing }
  expect(states()).toEqual(["owned", "owned", "retired"])
  expect(descriptor()).toBeNull()
  const stored = await store.get(keyId, recordId)
  expect(stored?.request.body).toEqual(Uint8Array.of(1))
  expect(stored?.response.body).toEqual({ type: "bytes", body: Uint8Array.of(2) })
})

test.each(["request-bytes", "response-events", "request-headers", "response-headers", "metadata"] as const)("mandatory %s preparation failure creates no stages, files, or rows", async part => {
  const puts: string[] = []
  const files: FileProvider = {
    async put(key, body, options) { puts.push(key); await realFiles.put(key, body, options) },
    get: realFiles.get.bind(realFiles), delete: realFiles.delete.bind(realFiles),
  }
  const input = record(snapshot())
  const fail = () => { throw new Error(`mandatory ${part} preparation failed`) }
  if (part === "request-bytes") {
    Object.defineProperty(input.request.body, "bytes", { get: fail })
  } else if (part === "response-events") {
    const event: Record<string, unknown> = {}
    event.self = event
    input.response.body = { type: "stream", events: [{ frame: { type: "event", event }, ts: 1 }] }
  } else if (part === "metadata") {
    Object.defineProperty(input.meta, "model", { get: fail, enumerable: true })
  } else {
    Object.defineProperty(part === "request-headers" ? input.request.headers : input.response.headers, "toJSON", { value: fail })
  }
  await expect(new FileDumpStore(db, files).put(keyId, input)).rejects.toThrow()
  expect(puts).toEqual([])
  expect(rowCount()).toBe(0)
  expect(states()).toEqual([])
  expect(await readdir(join(root, "files"))).toEqual([])
})

test.each(["req", "resp", "up"] as const)("synchronous %s put failure still waits for every started sibling", async failedSide => {
  const entered = gate(), release = gate(), started: Side[] = []
  const files: FileProvider = {
    put(key, body, options) {
      const side = sideOf(key)
      started.push(side)
      entered.resolve()
      if (side === failedSide) throw new Error(`synchronous ${side} failure`)
      return (async () => {
        await release.promise
        await realFiles.put(key, body, options)
      })()
    },
    get: realFiles.get.bind(realFiles), delete: realFiles.delete.bind(realFiles),
  }
  const store = new FileDumpStore(db, files)
  let settled = false
  const writing = store.put(keyId, record(snapshot())).then(
    () => { settled = true; return null }, error => { settled = true; return error as Error },
  )
  try {
    await Promise.race([entered.promise, writing])
    expect(started.toSorted()).toEqual(["req", "resp", "up"])
    await Bun.sleep(0)
    expect(settled).toBe(false)
    expect(rowCount()).toBe(0)
    expect(states()).toEqual(["staged", "staged", "staged"])
  } finally { release.resolve(); await writing }
  if (failedSide === "up") {
    expect(await writing).toBeNull()
    expect(states()).toEqual(["owned", "owned", "retired"])
    expect(descriptor()).toBeNull()
    const stored = await store.get(keyId, recordId)
    expect(stored?.request.body).toEqual(Uint8Array.of(1))
    expect(stored?.response.body).toEqual({ type: "bytes", body: Uint8Array.of(2) })
    expect(await collectDumpFiles(db, realFiles, Date.now() + 1)).toBe(1)
  } else {
    expect((await writing)?.message).toBe(`synchronous ${failedSide} failure`)
    expect(rowCount()).toBe(0)
    expect(states()).toEqual(["retired", "retired", "retired"])
    expect(await collectDumpFiles(db, realFiles, Date.now() + 1)).toBe(3)
  }
})

test("optional stage fallback excludes its key from the upload batch", async () => {
  raw.exec("CREATE TRIGGER reject_optional_stage BEFORE INSERT ON spilled_files WHEN NEW.owner_kind = 'dump-upstream' AND NEW.state = 'staged' BEGIN SELECT RAISE(ABORT, 'optional rejected'); END")
  const puts: Side[] = []
  const files: FileProvider = {
    async put(key, body, options) { puts.push(sideOf(key)); await realFiles.put(key, body, options) },
    get: realFiles.get.bind(realFiles), delete: realFiles.delete.bind(realFiles),
  }
  const store = new FileDumpStore(db, files)
  await store.put(keyId, record(snapshot()))
  expect(puts.toSorted()).toEqual(["req", "resp"])
  expect(states()).toEqual(["owned", "owned"])
  expect((await store.get(keyId, recordId))?.upstreamExchanges).toBeNull()
})

test.each(["none", "bytes"] as const)("empty canonical bodies omit uploads while empty capture remains present (%s)", async type => {
  const input = record(snapshot())
  input.request.body = { encoding: "identity", bytes: new Uint8Array(0), decodedByteLength: 0 }
  input.response.body = type === "none" ? { type } : { type, body: new Uint8Array(0) }
  const puts: Side[] = []
  const files: FileProvider = {
    async put(key, body, options) { puts.push(sideOf(key)); await realFiles.put(key, body, options) },
    get: realFiles.get.bind(realFiles), delete: realFiles.delete.bind(realFiles),
  }
  const store = new FileDumpStore(db, files)
  await store.put(keyId, input)
  expect(puts).toEqual(["up"])
  expect(states()).toEqual(["owned"])
  expect((await store.get(keyId, recordId))?.upstreamExchanges?.attempts).toEqual([])
})
