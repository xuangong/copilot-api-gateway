import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { migrationsDir } from "../src/migrations-dir.ts"
import { applyMigrations } from "@vibe-llm/platform-bun/src/migrate.ts"

const ledger = (db: Database) =>
  db.query<{ name: string }, []>("SELECT name FROM _migrations ORDER BY name").all().map((r) => r.name)

const tables = (db: Database) =>
  new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name),
  )

const scratchDir = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-test-"))
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
  return dir
}

const copyMigrationRange = (destination: string, start: number, end: number): void => {
  const source = fileURLToPath(migrationsDir)
  for (const file of readdirSync(source)) {
    const match = /^(\d{4})_/.exec(file)
    if (!match) continue
    const prefix = Number(match[1])
    if (prefix >= start && prefix <= end) copyFileSync(join(source, file), join(destination, file))
  }
}

describe("applyMigrations", () => {
  test("builds a full schema in an empty database", () => {
    const db = new Database(":memory:")
    applyMigrations(db)

    expect(ledger(db)[0]).toBe("0001_baseline.sql")

    const t = tables(db)
    for (const required of ["api_keys", "github_accounts", "usage", "users", "web_search_usage"]) {
      expect(t).toContain(required)
    }
    const apiKeyColumns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('api_keys')").all().map((r) => r.name)
    expect(apiKeyColumns).toContain("owner_id")
    expect(apiKeyColumns).toContain("model_mappings_enabled")
    expect(apiKeyColumns).toContain("model_mappings")
  })

  test("re-running is a no-op", () => {
    const db = new Database(":memory:")
    applyMigrations(db)
    const before = ledger(db)
    const schemaBefore = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master ORDER BY name").all()

    applyMigrations(db)

    expect(ledger(db)).toEqual(before)
    expect(db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schemaBefore)
  })

  // The baseline exists to be replayed over the two live databases, which were
  // built by the pre-migration bootstrap and have no ledger.
  test("fills gaps in a pre-ledger database without touching its data", () => {
    const db = new Database(":memory:")
    applyMigrations(db)
    db.exec("DROP TABLE responses_snapshots")
    db.exec("DROP TABLE _migrations")
    // A ledger-less database predates every migration, so its quota columns
    // still carry the daily names 0003 renames away, and 0004's cost column
    // does not exist yet.
    db.exec("ALTER TABLE api_keys RENAME COLUMN quota_requests_per_month TO quota_requests_per_day")
    db.exec("ALTER TABLE api_keys RENAME COLUMN quota_tokens_per_month TO quota_tokens_per_day")
    db.exec("ALTER TABLE api_keys DROP COLUMN quota_cost_per_month")
    // Same for 0005's per-key jina credential columns and 0006's passthrough
    // pair. 0006 also drops search_config, which `IF EXISTS` makes replayable.
    db.exec("ALTER TABLE api_keys DROP COLUMN web_search_jina_key")
    db.exec("ALTER TABLE api_keys DROP COLUMN web_search_jina_ref")
    db.exec("ALTER TABLE api_keys DROP COLUMN web_search_passthrough_upstream")
    db.exec("ALTER TABLE api_keys DROP COLUMN web_search_passthrough_model")
    db.exec("ALTER TABLE api_keys DROP COLUMN model_mappings_enabled")
    db.exec("ALTER TABLE api_keys DROP COLUMN model_mappings")
    db.exec("INSERT INTO users (id, name, created_at) VALUES ('u1', 'someone', '2026-01-01')")
    db.exec("INSERT INTO api_keys (id, name, key, created_at) VALUES ('k1', 'preserved', 'secret', '2026-01-01')")

    applyMigrations(db)

    expect(tables(db)).toContain("responses_snapshots")
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM users").get()!.n).toBe(1)
    expect(
      db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('api_keys')").all().map((r) => r.name),
    ).toEqual(expect.arrayContaining(["quota_requests_per_month", "model_mappings_enabled", "model_mappings"]))
    expect(
      db.query<{ name: string; enabled: number; mappings: string }, []>(
        "SELECT name, model_mappings_enabled AS enabled, model_mappings AS mappings FROM api_keys WHERE id = 'k1'",
      ).get(),
    ).toEqual({
      name: "preserved",
      enabled: 0,
      mappings: '[{"source":"gpt-5.6-sol","destination":"gpt-5.6-sol-fast"}]',
    })
  })

  test("applies 0007 to an existing ledger database without losing API key data", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-upgrade-test-"))
    copyMigrationRange(dir, 1, 6)
    const db = new Database(":memory:")
    applyMigrations(db, dir)
    db.exec("INSERT INTO users (id, name, created_at) VALUES ('u1', 'owner', '2026-01-01')")
    db.exec("INSERT INTO api_keys (id, name, key, created_at, owner_id, quota_requests_per_month) VALUES ('k1', 'preserved', 'secret', '2026-01-01', 'u1', 123)")

    copyMigrationRange(dir, 7, 7)
    applyMigrations(db, dir)

    expect(ledger(db)).toContain("0007_api_key_model_mappings.sql")
    expect(
      db.query<{ name: string; ownerId: string; quota: number; enabled: number; mappings: string }, []>(
        "SELECT name, owner_id AS ownerId, quota_requests_per_month AS quota, model_mappings_enabled AS enabled, model_mappings AS mappings FROM api_keys WHERE id = 'k1'",
      ).get(),
    ).toEqual({
      name: "preserved",
      ownerId: "u1",
      quota: 123,
      enabled: 0,
      mappings: '[{"source":"gpt-5.6-sol","destination":"gpt-5.6-sol-fast"}]',
    })
    const before = ledger(db)
    applyMigrations(db, dir)
    expect(ledger(db)).toEqual(before)
  })

  test("a failing file rolls back entirely and records nothing", () => {
    const dir = scratchDir({
      "0001_ok.sql": "CREATE TABLE a (id TEXT);",
      "0002_bad.sql": "CREATE TABLE b (id TEXT);\nTHIS IS NOT SQL;",
    })
    const db = new Database(":memory:")

    expect(() => applyMigrations(db, dir)).toThrow(/0002_bad\.sql/)

    expect(ledger(db)).toEqual(["0001_ok.sql"])
    expect(tables(db)).toContain("a")
    expect(tables(db)).not.toContain("b")
  })

  test("applies migrations added after an earlier run", () => {
    const dir = scratchDir({ "0001_init.sql": "CREATE TABLE api_keys (id TEXT);" })
    const db = new Database(":memory:")
    applyMigrations(db, dir)

    writeFileSync(join(dir, "0002_later.sql"), "CREATE TABLE later (id TEXT);")
    applyMigrations(db, dir)

    expect(ledger(db)).toEqual(["0001_init.sql", "0002_later.sql"])
    expect(tables(db)).toContain("later")
  })
})
