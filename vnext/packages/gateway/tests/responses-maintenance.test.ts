import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { createBunResponsesStore } from "@vibe-llm/platform-bun/src/responses-store-factory.ts"
import { sweepResponsesSnapshots } from "../src/responses-maintenance.ts"

let db: Database
let sql: BunSqliteDatabase
beforeEach(() => {
  db = new Database(":memory:")
  new BunSqliteRepo(db)
  sql = new BunSqliteDatabase(db)
  db.run("INSERT INTO api_keys (id, name, key, created_at, responses_retention_seconds) VALUES ('active', 'active', 'test', '2026-09-17', 86400)")
  db.run("INSERT INTO api_keys (id, name, key, created_at) VALUES ('disabled', 'disabled', 'test-disabled', '2026-09-17')")
})
afterEach(() => db.close())
function insert(id: string, owner: string | null, expires: number) {
  db.run("INSERT INTO responses_snapshots VALUES (?, ?, 'model', '[]', 1000, ?)", [id, owner, expires])
}
function ids(): string[] {
  return db.query<{ response_id: string }, []>("SELECT response_id FROM responses_snapshots ORDER BY response_id").all().map(row => row.response_id)
}

test("maintenance frees expired, disabled and orphan state without a new response write", async () => {
  insert("keep", "active", 2001)
  insert("expired", "active", 2000)
  insert("off", "disabled", 9999)
  insert("deleted-key", "missing", 9999)
  insert("anonymous", null, 9999)
  await sweepResponsesSnapshots(sql, 2000)
  expect(ids()).toEqual(["keep"])
})

test("one maintenance tick deletes bounded batches and later ticks drain the backlog", async () => {
  for (let i = 0; i < 450; i++) insert(`expired-${i}`, "active", 1500)
  await sweepResponsesSnapshots(sql, 2000)
  expect(ids()).toHaveLength(50)
  await sweepResponsesSnapshots(sql, 2000)
  expect(ids()).toHaveLength(0)
})

test("Bun SQL snapshots survive store recreation and respect exact expiration", async () => {
  const store = createBunResponsesStore(sql)
  const now = Date.now()
  await store.save({ responseId: "durable", apiKeyId: "active", model: "model", items: [], createdAt: now, expiresAt: now + 86400000 })
  expect(await createBunResponsesStore(sql).load("durable", "active")).not.toBeNull()
  await sweepResponsesSnapshots(sql, now + 86400000)
  expect(ids()).toEqual([])
})

test("maintenance uses the renewed deadline and eventually removes idle snapshots", async () => {
  const store = createBunResponsesStore(sql)
  const now = Date.now()
  await store.save({ responseId: "renewed", apiKeyId: "active", model: "model", items: [], createdAt: now, expiresAt: now + 60000 })
  const snapshot = await store.load("renewed", "active", { refreshRetentionSeconds: 86400 })
  if (!snapshot) throw new Error("Expected a renewed snapshot")
  await sweepResponsesSnapshots(sql, now + 60000)
  expect(ids()).toEqual(["renewed"])
  await sweepResponsesSnapshots(sql, snapshot.expiresAt)
  expect(ids()).toEqual([])
})
