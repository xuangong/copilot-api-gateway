import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
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
const keyId = "sidecar-key" as ApiKeyId
const recordId = "sidecar-record" as DumpRecordId

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dump-sidecar-"))
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

test("stages three keys before puts, writes one gzip sidecar before row, and distinguishes empty capture from legacy null", async () => {
  const order: string[] = []
  const files: FileProvider = {
    async put(key, body, options) {
      const stages = raw.query<{ owner_kind: string }, []>("SELECT owner_kind FROM spilled_files WHERE state = 'staged' ORDER BY owner_kind").all().map(row => row.owner_kind)
      expect(stages).toEqual(order.length < 3
        ? ["dump-request", "dump-response", "dump-upstream"]
        : ["dump-request", "dump-response"])
      expect(raw.query("SELECT id FROM dump_records").all()).toEqual([])
      order.push(key)
      await realFiles.put(key, body, options)
    },
    get: realFiles.get.bind(realFiles), delete: realFiles.delete.bind(realFiles),
  }
  const store = new FileDumpStore(db, files)
  await store.put(keyId, record(snapshot()))
  expect(order).toHaveLength(3)
  expect(order.filter(key => key.endsWith(".up.gz"))).toHaveLength(1)
  expect(descriptor()).not.toBeNull()
  const rows = raw.query<{ owner_kind: string; state: string }, []>("SELECT owner_kind, state FROM spilled_files ORDER BY owner_kind").all()
  expect(rows).toEqual([
    { owner_kind: "dump-request", state: "owned" },
    { owner_kind: "dump-response", state: "owned" },
    { owner_kind: "dump-upstream", state: "owned" },
  ])
  expect((await store.get(keyId, recordId))?.upstreamExchanges?.attempts).toEqual([])
  raw.run("DELETE FROM dump_records")
  await store.put(keyId, record(null))
  expect(descriptor()).toBeNull()
  expect((await store.get(keyId, recordId))?.upstreamExchanges).toBeNull()
})

test("sidecar file failure retires its stage and preserves the core dump", async () => {
  const files: FileProvider = {
    async put(key, body, options) {
      if (key.endsWith(".up.gz")) throw new Error("sidecar unavailable")
      await realFiles.put(key, body, options)
    },
    get: realFiles.get.bind(realFiles), delete: realFiles.delete.bind(realFiles),
  }
  const store = new FileDumpStore(db, files)
  await store.put(keyId, record(snapshot()))
  expect(descriptor()).toBeNull()
  expect((await store.get(keyId, recordId))?.response.body.type).toBe("bytes")
  const sidecar = raw.query<{ state: string }, []>("SELECT state FROM spilled_files WHERE owner_kind = 'dump-upstream'").get()
  expect(sidecar?.state).toBe("retired")
  expect(await collectDumpFiles(db, realFiles, Date.now() + 1)).toBe(1)
})

test("pre-row SQL failure retires all stages and leaves no referenced row", async () => {
  raw.exec("CREATE TRIGGER reject_sidecar_dump BEFORE INSERT ON dump_records BEGIN SELECT RAISE(ABORT, 'synthetic'); END")
  const store = new FileDumpStore(db, realFiles)
  await expect(store.put(keyId, record(snapshot()))).rejects.toThrow()
  expect(raw.query("SELECT id FROM dump_records").all()).toEqual([])
  expect(raw.query<{ state: string }, []>("SELECT state FROM spilled_files").all().map(row => row.state)).toEqual(["retired", "retired", "retired"])
  expect(await collectDumpFiles(db, realFiles, Date.now() + 1)).toBe(3)
})

test("externally missing referenced sidecar rejects detail while preserving the row", async () => {
  const store = new FileDumpStore(db, realFiles)
  await store.put(keyId, record(snapshot()))
  const key = JSON.parse(descriptor() ?? "null") as { key: string } | null
  if (!key) throw new Error("missing sidecar descriptor")
  await realFiles.delete(key.key)
  await expect(store.get(keyId, recordId)).rejects.toThrow()
  expect(raw.query("SELECT id FROM dump_records").all()).toHaveLength(1)
})

test("untrusted metadata never enters a sidecar, and invalid sidecar degrades to null", async () => {
  const store = new FileDumpStore(db, realFiles)
  const unsafe = {
    ...snapshot(),
    attempts: [{ url: "https://token@host.invalid/secret?key=secret", requestHeaders: [["Authorization", "Bearer secret"]] }],
  } as unknown as DumpWriteRecord["upstreamExchanges"]
  await store.put(keyId, record(unsafe))
  expect(descriptor()).toBeNull()
  expect((await store.get(keyId, recordId))?.upstreamExchanges).toBeNull()
  expect(raw.query<{ owner_kind: string }, []>("SELECT owner_kind FROM spilled_files").all().map(row => row.owner_kind)).not.toContain("dump-upstream")
})

test.each([false, true])("late sidecar put after stage collection preserves core and repairs tombstone (put throws: %s)", async putThrows => {
  let enteredResolve: (() => void) | null = null
  let releaseResolve: (() => void) | null = null
  const entered = new Promise<void>(resolve => { enteredResolve = resolve })
  const release = new Promise<void>(resolve => { releaseResolve = resolve })
  let fileKey = ""
  const files: FileProvider = {
    async put(key, body, options) {
      if (key.endsWith(".up.gz")) {
        fileKey = key
        enteredResolve?.()
        await release
        await realFiles.put(key, body, options)
        if (putThrows) throw new Error("late partial put")
        return
      }
      await realFiles.put(key, body, options)
    },
    get: realFiles.get.bind(realFiles), delete: realFiles.delete.bind(realFiles),
  }
  const store = new FileDumpStore(db, files)
  const writing = store.put(keyId, record(snapshot()))
  await entered
  raw.run("UPDATE spilled_files SET collect_after = 0 WHERE owner_kind = 'dump-upstream'")
  expect(await collectDumpFiles(db, realFiles, Date.now())).toBe(1)
  releaseResolve?.()
  await writing
  expect(descriptor()).toBeNull()
  expect((await store.get(keyId, recordId))?.response.body.type).toBe("bytes")
  expect(raw.query<{ state: string }, [string]>("SELECT state FROM spilled_files WHERE file_key = ?").get(fileKey)?.state).toBe("retired")
  for (let tick = 0; tick < 2; tick++) await collectDumpFiles(db, realFiles, Date.now() + 1)
  expect(await realFiles.get(fileKey)).toBeNull()
  expect(raw.query("SELECT file_key FROM spilled_files WHERE owner_kind = 'dump-upstream'").all()).toEqual([])
})

test("retention expiry retires and collects the owned sidecar with core files", async () => {
  const store = new FileDumpStore(db, realFiles)
  await store.put(keyId, record(snapshot()))
  raw.run("UPDATE api_keys SET dump_retention_seconds = 1 WHERE id = ?", [keyId])
  raw.run("UPDATE dump_records SET created_at = ? WHERE key_id = ?", [Date.now() - 60_000, keyId])
  expect(await store.deleteExpiredBatch(keyId, Date.now(), 10)).toBe(1)
  expect(raw.query<{ state: string }, []>("SELECT state FROM spilled_files").all().map(row => row.state)).toEqual(["retired", "retired", "retired"])
  expect(await collectDumpFiles(db, realFiles, Date.now())).toBe(3)
})
