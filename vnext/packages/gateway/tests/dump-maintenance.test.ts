import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { FsFileProvider } from "@vibe-llm/platform-bun/src/fs-file-provider.ts"
import type { FileProvider } from "@vibe-core/platform"

let raw: Database
let db: BunSqliteDatabase
let files: FsFileProvider
let root: string
const now = 10_000_000
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dump-maintenance-"))
  raw = new Database(join(root, "test.sqlite"))
  new BunSqliteRepo(raw)
  db = new BunSqliteDatabase(raw)
  files = new FsFileProvider(join(root, "files"))
  for (const id of ["active", "disabled", "cleared", "deleted"]) {
    raw.run("INSERT INTO api_keys (id, name, key, created_at, dump_retention_seconds) VALUES (?, ?, ?, '2026-09-29', 3600)", [id, id, id])
  }
  raw.run("INSERT INTO users (id, name, created_at, disabled) VALUES ('disabled-owner', 'Disabled', '2026-09-29', 1)")
  raw.run("UPDATE api_keys SET owner_id = 'disabled-owner' WHERE id = 'disabled'")
})
afterEach(async () => { raw.close(); await rm(root, { recursive: true, force: true }) })
function record(id: string, owner = "active", time = now, request: string | null = null, response: string | null = null) {
  raw.run(`INSERT INTO dump_records (key_id, id, created_at, meta_json, request_headers_json, request_body_descriptor, response_body_descriptor)
    VALUES (?, ?, ?, '{}', '[]', ?, ?)`, [owner, id, time, request === null ? null : JSON.stringify({ key: request, type: "bytes" }), response === null ? null : JSON.stringify({ key: response, type: "bytes" })])
}
async function stage(key: string, id: string, after = 0, kind = "dump-request", owner = "active") {
  raw.run("INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after) VALUES (?, ?, ?, 'staged', ?)", [key, kind, JSON.stringify([owner, id]), after])
  await files.put(key, "body")
}
function count(table: "dump_records" | "spilled_files") {
  return raw.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n
}
function metadata(key: string) {
  return raw.query<{ state: string; claim_token: string | null }, [string]>("SELECT state, claim_token FROM spilled_files WHERE file_key = ?").get(key)
}
const maintenance = () => import("../src/maintenance.ts")

test.each(["request", "response"] as const)("reference guards reject claimed, absent, retired and mismatched %s files", async side => {
  const attach = (id: string, key: string) => record(id, "active", now, side === "request" ? key : null, side === "response" ? key : null)
  await stage("dumps/v1/claimed", "claimed", 0, `dump-${side}`)
  raw.run("UPDATE spilled_files SET claim_token = 'collector', claimed_at = 0")
  expect(() => attach("claimed", "dumps/v1/claimed")).toThrow()
  expect(() => attach("absent", "dumps/v1/absent")).toThrow()
  raw.run("UPDATE spilled_files SET state = 'retired', claim_token = NULL, claimed_at = NULL")
  expect(() => attach("claimed", "dumps/v1/claimed")).toThrow()
  await stage("dumps/v1/wrong", "other", 0, `dump-${side}`)
  expect(() => attach("wrong", "dumps/v1/wrong")).toThrow()
  expect(count("dump_records")).toBe(0)
})

test("descriptor and ownership updates cannot attach collectible files or abandon owned bodies", async () => {
  await stage("dumps/v1/owned", "record")
  record("record", "active", now, "dumps/v1/owned")
  await stage("dumps/v1/new", "record")
  expect(() => raw.run("UPDATE dump_records SET request_body_descriptor = ?", [JSON.stringify({ key: "dumps/v1/new", type: "bytes" })])).toThrow()
  expect(() => raw.run("UPDATE dump_records SET id = 'renamed'")).toThrow()
  expect(() => raw.run("UPDATE dump_records SET response_body_descriptor = ?", [JSON.stringify({ key: "dumps/v1/new", type: "bytes" })])).toThrow()
  expect(() => raw.run("UPDATE dump_records SET request_body_descriptor = NULL")).toThrow()
  raw.run("UPDATE dump_records SET meta_json = '{}' ")
  expect(metadata("dumps/v1/owned")?.state).toBe("owned")
})

test("global expiration honors retention for a disabled owner and visits cleared and deleted key histories", async () => {
  const { sweepDumpRecords } = await maintenance()
  for (const owner of ["active", "disabled", "cleared", "deleted"]) {
    record(`${owner}-old`, owner, now - 3_600_001)
    record(`${owner}-edge`, owner, now - 3_600_000)
  }
  raw.run("UPDATE api_keys SET dump_retention_seconds = NULL WHERE id = 'cleared'")
  raw.run("DELETE FROM api_keys WHERE id = 'deleted'")
  expect(await sweepDumpRecords(db, files, now)).toBe(6)
  expect(raw.query<{ id: string }, []>("SELECT id FROM dump_records ORDER BY id").all().map(r => r.id)).toEqual(["active-edge", "disabled-edge"])
})

test("dump key cursor bounds each tick and revisits busy keys after covering untouched histories", async () => {
  const { sweepDumpRecords } = await maintenance()
  for (let i = 0; i < 40; i++) {
    for (let j = 0; j < 30; j++) record(`${i}-${j}`, `missing-${String(i).padStart(3, "0")}`, 0)
  }
  expect(await sweepDumpRecords(db, files, now)).toBe(400)
  expect(count("dump_records")).toBe(800)
  for (let tick = 0; tick < 12; tick++) await sweepDumpRecords(db, files, now)
  expect(count("dump_records")).toBe(0)
})

test("collector preserves fresh stages, owned/reference bodies and non-dump files", async () => {
  const { collectDumpFiles } = await maintenance()
  await stage("dumps/v1/fresh", "fresh", now + 1)
  await stage("dumps/v1/expired", "expired", now)
  await stage("dumps/v1/owned", "owned")
  record("owned", "active", now, "dumps/v1/owned")
  await stage("dumps/v1/referenced", "referenced", 0, "dump-response")
  record("referenced", "active", now, null, "dumps/v1/referenced")
  // Legacy/inconsistent metadata must still be protected by a live descriptor.
  raw.run("UPDATE spilled_files SET state = 'retired', collect_after = 0 WHERE file_key = 'dumps/v1/referenced'")
  await stage("dumps/v1/retired", "retired")
  record("retired", "active", now, "dumps/v1/retired")
  raw.run("DELETE FROM dump_records WHERE id = 'retired'")
  await stage("other/file", "other")
  await stage("dumps/v1/other-kind", "other-kind", 0, "attachment")
  expect(await collectDumpFiles(db, files, now)).toBe(2)
  expect(await files.get("dumps/v1/expired")).toBeNull()
  expect(await files.get("dumps/v1/retired")).toBeNull()
  for (const key of ["fresh", "owned", "referenced", "other-kind"]) expect(await files.get(`dumps/v1/${key}`)).not.toBeNull()
  expect(await files.get("other/file")).not.toBeNull()
})

test("collector bounds scans, advances past held claims, and drains backlog on subsequent ticks", async () => {
  const { collectDumpFiles } = await maintenance()
  for (let i = 0; i < 240; i++) await stage(`dumps/v1/${String(i).padStart(3, "0")}`, `${i}`)
  raw.run("UPDATE spilled_files SET claim_token = 'held', claimed_at = ? WHERE file_key < 'dumps/v1/100'", [now])
  expect(await collectDumpFiles(db, files, now)).toBe(0)
  expect(await collectDumpFiles(db, files, now)).toBe(100)
  expect(await collectDumpFiles(db, files, now)).toBe(40)
  expect(count("spilled_files")).toBe(100)
  for (let tick = 0; tick < 3; tick++) await collectDumpFiles(db, files, now + 300_001)
  expect(count("spilled_files")).toBe(0)
})

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("concurrent collectors claim once and insert cannot attach a claimed stage", async () => {
  const { collectDumpFiles } = await maintenance()
  await stage("dumps/v1/race", "race")
  const entered = deferred(), release = deferred()
  let deletes = 0
  const slow: FileProvider = {
    put: files.put.bind(files), get: files.get.bind(files),
    async delete(key) { deletes++; entered.resolve(); await release.promise; await files.delete(key) },
  }
  const first = collectDumpFiles(db, slow, now)
  await entered.promise
  expect(() => record("race", "active", now, "dumps/v1/race")).toThrow()
  const competingRaw = new Database(join(root, "test.sqlite"))
  try {
    expect(await collectDumpFiles(new BunSqliteDatabase(competingRaw), files, now)).toBe(0)
  } finally { competingRaw.close() }
  release.resolve()
  expect(await first).toBe(1)
  expect(deletes).toBe(1)
  expect(metadata("dumps/v1/race")).toBeNull()
})

test("expired claim takeover fences the old worker metadata delete", async () => {
  const { collectDumpFiles } = await maintenance()
  await stage("dumps/v1/fence", "fence")
  const firstEntered = deferred(), firstRelease = deferred(), secondEntered = deferred(), secondRelease = deferred()
  const slow = (entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>): FileProvider => ({
    put: files.put.bind(files), get: files.get.bind(files),
    async delete(key) { entered.resolve(); await release.promise; await files.delete(key) },
  })
  const first = collectDumpFiles(db, slow(firstEntered, firstRelease), now)
  await firstEntered.promise
  await collectDumpFiles(db, files, now) // reset scan cursor at end
  const second = collectDumpFiles(db, slow(secondEntered, secondRelease), now + 300_001)
  await secondEntered.promise
  const newToken = metadata("dumps/v1/fence")?.claim_token
  firstRelease.resolve()
  expect(await first).toBe(0)
  expect(metadata("dumps/v1/fence")?.claim_token).toBe(newToken)
  secondRelease.resolve()
  expect(await second).toBe(1)
})

test("external deletion failure retains metadata and doesn't block another file", async () => {
  const { collectDumpFiles } = await maintenance()
  await stage("dumps/v1/fail", "fail")
  await stage("dumps/v1/pass", "pass")
  const failing: FileProvider = {
    put: files.put.bind(files), get: files.get.bind(files),
    async delete(key) { if (key.endsWith("fail")) throw new Error("secret payload must not be logged"); await files.delete(key) },
  }
  expect(await collectDumpFiles(db, failing, now)).toBe(1)
  expect(metadata("dumps/v1/fail")).not.toBeNull()
  expect(await files.get("dumps/v1/fail")).not.toBeNull()
  for (let tick = 0; tick < 2; tick++) await collectDumpFiles(db, files, now + 300_001)
  expect(count("spilled_files")).toBe(0)
})

test("metadata delete failure after successful file removal remains retryable", async () => {
  const { collectDumpFiles } = await maintenance()
  await stage("dumps/v1/row-fail", "row-fail")
  raw.exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON spilled_files BEGIN SELECT RAISE(ABORT, 'test failure'); END")
  expect(await collectDumpFiles(db, files, now)).toBe(0)
  expect(await files.get("dumps/v1/row-fail")).toBeNull()
  expect(metadata("dumps/v1/row-fail")).not.toBeNull()
  raw.exec("DROP TRIGGER reject_cleanup")
  for (let tick = 0; tick < 2; tick++) await collectDumpFiles(db, files, now + 300_001)
  expect(metadata("dumps/v1/row-fail")).toBeNull()
})

test("maintenance failures are isolated so Responses, dumps and files all get their turn", async () => {
  const { sweepMaintenance } = await maintenance()
  record("expired", "deleted", 0)
  await stage("dumps/v1/orphan", "orphan")
  raw.exec("DROP TABLE responses_snapshots")
  await sweepMaintenance(db, files, now)
  expect(count("dump_records")).toBe(0)
  expect(count("spilled_files")).toBe(0)
})

test.each([false, true])("late file put repairs a retired tombstone after collection (metadata deletion pending: %s)", async pendingMetadataDelete => {
  const { collectDumpFiles } = await maintenance()
  const { FileDumpStore } = await import("../src/repo/dump-store.ts")
  const { repoId, dumpId } = await import("./helpers/dump-maintenance-ids.ts")
  const putEntered = deferred(), putRelease = deferred(), deleteEntered = deferred(), deleteRelease = deferred()
  let fileKey = ""
  const slowWriter: FileProvider = {
    get: files.get.bind(files), delete: files.delete.bind(files),
    async put(key, body, opts) { fileKey = key; putEntered.resolve(); await putRelease.promise; await files.put(key, body, opts) },
  }
  const store = new FileDumpStore(db, slowWriter)
  const write = store.put(repoId("active"), {
    meta: {
      id: dumpId("slow"), startedAt: now, completedAt: now, method: "POST", path: "/v1/responses", status: 200,
      upstream: null, model: "test", inputTokens: 0, outputTokens: 0, requestBytes: 4, responseBytes: 0, durationMs: 0, error: null,
    },
    request: { method: "POST", path: "/v1/responses", headers: [], body: { encoding: "identity", bytes: new TextEncoder().encode("body"), decodedByteLength: 4 } },
    response: { status: 200, headers: [], body: { type: "none" } },
  }).then(() => null, error => error as unknown)
  await putEntered.promise
  raw.run("UPDATE spilled_files SET collect_after = 0")
  const collector: FileProvider = {
    put: files.put.bind(files), get: files.get.bind(files),
    async delete(key) { await files.delete(key); deleteEntered.resolve(); if (pendingMetadataDelete) await deleteRelease.promise },
  }
  const collection = collectDumpFiles(db, collector, now)
  await deleteEntered.promise
  if (!pendingMetadataDelete) await collection
  putRelease.resolve()
  expect(await write).toBeInstanceOf(Error)
  expect(count("dump_records")).toBe(0)
  expect(metadata(fileKey)?.state).toBe("retired")
  deleteRelease.resolve()
  await collection
  // Repair also fences a collector that had removed the file but not metadata.
  expect(metadata(fileKey)?.state).toBe("retired")
  for (let tick = 0; tick < 2; tick++) await collectDumpFiles(db, files, now)
  expect(await files.get(fileKey)).toBeNull()
  expect(metadata(fileKey)).toBeNull()
})

test("REPLACE cannot abandon an existing owned descriptor", async () => {
  await stage("dumps/v1/original", "record")
  record("record", "active", now, "dumps/v1/original")
  await stage("dumps/v1/replacement", "record")
  expect(() => raw.run(`INSERT OR REPLACE INTO dump_records (key_id, id, created_at, meta_json, request_headers_json, request_body_descriptor)
    VALUES ('active', 'record', ?, '{}', '[]', ?)`, [now, JSON.stringify({ key: "dumps/v1/replacement", type: "bytes" })])).toThrow()
  expect(metadata("dumps/v1/original")?.state).toBe("owned")
  expect(metadata("dumps/v1/replacement")?.state).toBe("staged")
})

test("a failed dump sweep does not block Responses or file collection", async () => {
  const { sweepMaintenance } = await maintenance()
  record("blocked", "deleted", 0)
  raw.exec("CREATE TRIGGER reject_dump_cleanup BEFORE DELETE ON dump_records BEGIN SELECT RAISE(ABORT, 'test failure'); END")
  raw.run("INSERT INTO responses_snapshots VALUES ('expired', 'active', 'model', '[]', 0, 1)")
  await stage("dumps/v1/collect", "collect")
  await sweepMaintenance(db, files, now)
  expect(count("dump_records")).toBe(1)
  expect(raw.query("SELECT * FROM responses_snapshots").all()).toHaveLength(0)
  expect(count("spilled_files")).toBe(0)
})

function observeSql(afterAll?: (count: number) => void) {
  const statements: Array<{ sql: string; binds: unknown[] }> = []
  let calls = 0
  class ObservedDatabase extends BunSqliteDatabase {
    override prepare(sql: string) {
      const statement = super.prepare(sql)
      const observed = { sql, binds: [] as unknown[] }
      statements.push(observed)
      const bind = statement.bind.bind(statement)
      statement.bind = (...values: unknown[]) => {
        observed.binds = values
        return bind(...values)
      }
      const all = statement.all.bind(statement)
      statement.all = async <T>() => {
        const result = await all<T>()
        afterAll?.(++calls)
        return result
      }
      return statement
    }
  }
  return { observedDb: new ObservedDatabase(raw), statements }
}

test("inactive cleanup checks retained-key state before traversing its history", async () => {
  const { FileDumpStore } = await import("../src/repo/dump-store.ts")
  const { repoId } = await import("./helpers/dump-maintenance-ids.ts")
  raw.transaction(() => {
    for (let i = 0; i < 1000; i++) record(`retained-${i}`)
  })()
  const { observedDb, statements } = observeSql()
  expect(await new FileDumpStore(observedDb, files).deleteExpiredBatch(repoId("active"), now, 25)).toBe(0)
  const inactive = statements[1]
  if (!inactive) throw new Error("Expected the inactive cleanup statement")
  const plan = raw.query<{ detail: string }, never[]>(`EXPLAIN QUERY PLAN ${inactive.sql}`)
    .all(...inactive.binds as never[]).map(row => row.detail)
  const keyLookup = plan.findIndex(detail => detail.includes("SEARCH api_keys"))
  const historyLookup = plan.findIndex(detail => detail.includes("SEARCH records"))
  expect(keyLookup).toBeGreaterThanOrEqual(0)
  expect(historyLookup).toBeGreaterThan(keyLookup)
  expect(plan.some(detail => detail.includes("CORRELATED"))).toBe(false)
  expect(count("dump_records")).toBe(1000)
})

test.each(["clear", "retain"] as const)("inactive cleanup rechecks retention changed between DELETE statements: %s", async change => {
  const { FileDumpStore } = await import("../src/repo/dump-store.ts")
  const { repoId } = await import("./helpers/dump-maintenance-ids.ts")
  for (let i = 0; i < 30; i++) record(`fresh-${i}`)
  if (change === "retain") raw.run("UPDATE api_keys SET dump_retention_seconds = NULL WHERE id = 'active'")
  const other = new Database(join(root, "test.sqlite"))
  try {
    const { observedDb } = observeSql(calls => {
      if (calls === 1) other.run("UPDATE api_keys SET dump_retention_seconds = ? WHERE id = 'active'", [change === "clear" ? null : 3600])
    })
    expect(await new FileDumpStore(observedDb, files).deleteExpiredBatch(repoId("active"), now, 25))
      .toBe(change === "clear" ? 25 : 0)
    expect(count("dump_records")).toBe(change === "clear" ? 5 : 30)
  } finally { other.close() }
})
