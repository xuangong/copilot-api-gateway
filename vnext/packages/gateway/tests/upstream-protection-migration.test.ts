import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { applyMigrations } from "@vibe-llm/platform-bun/src/migrate.ts"

const columns = (db: Database, table: string): string[] =>
  db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all().map(row => row.name)

test("migration 0027 creates the protection tables", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    expect(columns(db, "upstream_request_minutes")).toEqual(
      ["minute", "upstream_id", "key_id", "model", "requests", "rate_limited", "rejected", "auth", "upstream", "network", "other"])
    expect(columns(db, "upstream_error_samples")).toEqual(["upstream_id", "status", "at", "key_id", "model", "code", "message"])
    expect(columns(db, "protection_pauses")).toEqual(
      ["id", "target_kind", "target_id", "upstream_id", "mode", "reason_json", "started_at", "ends_at", "resolved_at", "resolved_by"])
    expect(columns(db, "upstream_protection_settings")).toEqual(["upstream_id", "settings_json", "updated_at"])
  } finally { db.close() }
})

test("the minute row is unique per (upstream, minute, key, model) and upserts count", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    const upsert = `INSERT INTO upstream_request_minutes (minute, upstream_id, key_id, model, requests, rate_limited) VALUES (60, 'u', 'k', 'm', 1, 1)
      ON CONFLICT (upstream_id, minute, key_id, model) DO UPDATE SET requests = requests + 1, rate_limited = rate_limited + 1`
    db.run(upsert)
    db.run(upsert)
    expect(db.query("SELECT requests, rate_limited FROM upstream_request_minutes").all()).toEqual([{ requests: 2, rate_limited: 2 }])
  } finally { db.close() }
})

test("pause rows reject unknown kinds and modes, and the active lookup uses the partial index", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    let n = 0
    const insert = (kind: string, mode: string) => db.run(
      "INSERT INTO protection_pauses (id, target_kind, target_id, upstream_id, mode, reason_json, started_at, ends_at) VALUES (?, ?, 't', 'u', ?, '{}', 1, 2)",
      [`pp_${(++n).toString(16).padStart(32, "0")}`, kind, mode])
    expect(() => insert("galaxy", "pause")).toThrow()
    expect(() => insert("key", "ban")).toThrow()
    insert("key", "pause")
    const plan = db.query<{ detail: string }, []>(
      "EXPLAIN QUERY PLAN SELECT id FROM protection_pauses WHERE resolved_at IS NULL AND ends_at > 5").all().map(row => row.detail)
    expect(plan.some(detail => detail.includes("idx_protection_pauses_active"))).toBe(true)
  } finally { db.close() }
})

test("the per-key bucket query stays on the primary key", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    const plan = db.query<{ detail: string }, []>(
      `EXPLAIN QUERY PLAN SELECT (minute / 3600) * 3600 AS t, SUM(requests) FROM upstream_request_minutes
       WHERE upstream_id = 'u' AND minute >= 0 AND minute < 9 AND +key_id = 'k' GROUP BY t ORDER BY t`).all().map(row => row.detail)
    expect(plan.some(detail => detail.includes("sqlite_autoindex_upstream_request_minutes") || detail.includes("PRIMARY KEY"))).toBe(true)
    expect(plan.some(detail => detail.includes("idx_upstream_request_minutes_key"))).toBe(false)
  } finally { db.close() }
})
