import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { IDLE_ASSIGNMENTS_SQL } from "../src/repo/shared/quota-balance"
import { applyMigrations } from "@vibe-llm/platform-bun/src/migrate.ts"

const columns = (db: Database, table: string): string[] =>
  db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all().map(row => row.name)

test("migration 0028 creates the quota balancing tables and the membership column", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    expect(columns(db, "upstream_groups")).toEqual(["id", "owner_id", "name", "enabled", "sort_order", "settings_json", "created_at", "updated_at"])
    expect(columns(db, "upstreams")).toContain("group_id")
    expect(columns(db, "session_assignments")).toEqual(
      ["group_id", "session_key", "upstream_id", "created_at", "last_seen_at", "moved_at", "recent_cost_usd", "recent_cost_at"])
    expect(columns(db, "quota_reads")).toEqual(
      ["upstream_id", "at", "source", "used", "entitlement", "unlimited", "share", "cost_total_usd", "estimated_share_before", "error_points", "snapshot_key", "unit_form", "reset_at"])
    expect(columns(db, "upstream_quota_state")).toEqual([
      "upstream_id", "k", "k_prev", "k_samples", "o", "o_samples", "interval_hours", "learn_since", "last_read_at", "last_read_share", "last_read_unlimited", "last_read_source",
      "last_attempt_at", "last_calibration_at", "day_key", "day_reads", "failures", "last_error", "next_read_at", "last_error_points", "entitlement", "entitlement_from", "entitlement_changed_at",
      "cost_total_usd", "cost_at_read_usd", "month_key", "month_cost_usd", "updated_at"])
    expect(columns(db, "upstream_cost_buckets")).toEqual(["upstream_id", "bucket", "cost_usd"])
  } finally { db.close() }
})

test("group ids are ug_ plus 32 characters, a session has one assignment per group, a read is unique per instant", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    const group = (id: string) => db.run("INSERT INTO upstream_groups (id, owner_id, name, created_at, updated_at) VALUES (?, 'u', 'g', 'now', 'now')", [id])
    expect(() => group("ug_short")).toThrow()
    expect(() => group("xx_" + "1".repeat(32))).toThrow()
    group("ug_" + "1".repeat(32))
    const assign = () => db.run("INSERT INTO session_assignments (group_id, session_key, upstream_id, created_at, last_seen_at, moved_at) VALUES ('g', 's', 'up', 1, 1, 1)")
    assign()
    expect(assign).toThrow()
    const read = () => db.run("INSERT INTO quota_reads (upstream_id, at, source, used, entitlement, share, cost_total_usd) VALUES ('up', 5, 'github', 1, 2, 0.5, 0)")
    read()
    expect(read).toThrow()
    expect(() => db.run("INSERT INTO quota_reads (upstream_id, at, source, used, entitlement, share, cost_total_usd) VALUES ('up', 6, 'telepathy', 1, 2, 0.5, 0)")).toThrow()
  } finally { db.close() }
})

test("membership lookups and the idle-assignment sweep use their indexes", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    const plan = (sql: string) => db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail).join("\n")
    expect(plan("SELECT id FROM upstreams WHERE group_id = 'ug_x'")).toContain("idx_upstreams_group")
    expect(plan("SELECT rowid FROM session_assignments WHERE last_seen_at < 5")).toContain("idx_session_assignments_seen")
    expect(plan("SELECT 1 FROM session_assignments WHERE upstream_id = 'up'")).toContain("idx_session_assignments_upstream")
    expect(plan("SELECT bucket FROM upstream_cost_buckets WHERE bucket < 5")).toContain("idx_upstream_cost_buckets_bucket")
    expect(plan("SELECT at FROM quota_reads WHERE at < 5")).toContain("idx_quota_reads_at")
  } finally { db.close() }
})

test("the idle-assignment retention query is a range scan on last_seen_at, not a table scan", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    const inner = IDLE_ASSIGNMENTS_SQL.replace(/^DELETE FROM session_assignments WHERE rowid IN \(/, "").replace(/\)$/, "")
    const plan = db.query<{ detail: string }, unknown[]>(`EXPLAIN QUERY PLAN ${inner}`).all(1, 2, 3).map(row => row.detail).join("\n")
    expect(plan).toContain("idx_session_assignments_seen")
    expect(plan).not.toMatch(/SCAN a\b(?! USING)/)
  } finally { db.close() }
})

test("grouping an upstream does not bump the configuration revision", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    db.run(`INSERT INTO upstreams (catalog_generation, credential_generation, row_incarnation, id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, state_json, proxy_fallback_list_json, created_at, updated_at)
            VALUES (0, 0, 'r', 'up_test_a', 'u', 'copilot', 'A', 1, 0, '{}', '{}', '[]', NULL, '[]', 'now', 'now')`)
    const revision = () => db.query<{ revision: number }, []>("SELECT revision FROM configuration_revision WHERE id = 1").get()!.revision
    const before = revision()
    db.run("UPDATE upstreams SET group_id = 'ug_x' WHERE id = 'up_test_a'")
    expect(revision()).toBe(before)
  } finally { db.close() }
})
