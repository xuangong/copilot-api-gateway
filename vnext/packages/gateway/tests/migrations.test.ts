import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { migrationsDir } from "../src/migrations-dir.ts"
import { applyMigrations } from "@vibe-llm/platform-bun/src/migrate.ts"

const dir = fileURLToPath(migrationsDir.href)
const baselinePath = fileURLToPath(new URL("./schema-baseline.txt", import.meta.url).href)

/** Collapse whitespace so formatting churn inside a migration isn't a diff. */
const normalize = (sql: string) => sql.replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").trim()

const snapshot = (db: Database) =>
  db
    .query<{ type: string; name: string; sql: string | null }, []>(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all()
    .map((r) => `${r.type}\t${r.name}\t${normalize(r.sql ?? "")}`)
    .join("\n")

const listSql = () => readdirSync(dir).filter((f) => f.endsWith(".sql"))

describe("migration corpus", () => {
  test("shared-session upgrade defaults off, preserves isolated secrets and revises changed configuration", () => {
    const db = new Database(":memory:")
    try {
      db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY)")
      for (const file of listSql().sort().filter(file => file < "0024_")) {
        db.exec(readFileSync(`${dir}/${file}`, "utf8"))
        db.run("INSERT INTO _migrations (name) VALUES (?)", [file])
      }
      db.run("INSERT INTO api_keys (id,name,key,created_at,affinity_secret,affinity_key_id,affinity_version) VALUES ('existing','test','test','now','legacy-secret','legacy-id',1)")
      applyMigrations(db, dir)
      applyMigrations(db, dir)
      expect(db.query("SELECT shared_session_enabled,shared_session_secret,affinity_secret,affinity_key_id,affinity_version FROM api_keys").get()).toEqual({
        shared_session_enabled: 0, shared_session_secret: null, affinity_secret: "legacy-secret", affinity_key_id: "legacy-id", affinity_version: 1,
      })
      const revision = () => db.query<{ revision: number }, []>("SELECT revision FROM configuration_revision WHERE id=1").get()?.revision ?? -1
      const before = revision()
      db.run("UPDATE api_keys SET shared_session_enabled=1,shared_session_secret=?", ["ab".repeat(32)])
      expect(revision()).toBe(before + 1)
      db.run("UPDATE api_keys SET shared_session_enabled=1")
      expect(revision()).toBe(before + 1)
      db.run("UPDATE api_keys SET shared_session_enabled=0")
      expect(revision()).toBe(before + 2)
    } finally { db.close() }
  })

  test("upstream sidecar migration keeps legacy rows capture-unavailable and applies once", () => {
    const db = new Database(":memory:")
    try {
      db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY)")
      for (const file of listSql().sort().filter(file => file < "0016_")) {
        db.exec(readFileSync(`${dir}/${file}`, "utf8"))
        db.run("INSERT INTO _migrations (name) VALUES (?)", [file])
      }
      db.run("INSERT INTO dump_records (key_id, id, created_at, meta_json, request_headers_json) VALUES ('legacy-key', 'legacy-record', 1, '{}', '[]')")
      applyMigrations(db, dir)
      applyMigrations(db, dir)
      expect(db.query<{ upstream_exchanges_descriptor: string | null }, []>("SELECT upstream_exchanges_descriptor FROM dump_records").get()?.upstream_exchanges_descriptor).toBeNull()
      expect(db.query("SELECT name FROM _migrations WHERE name = '0016_dump_upstream_exchanges.sql'").all()).toHaveLength(1)
    } finally { db.close() }
  })

  test("Host key migration preserves existing keys and records its upgrade only once", () => {
    const db = new Database(":memory:")
    try {
      db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY)")
      for (const file of listSql().sort().filter(file => file < "0014_")) {
        db.exec(readFileSync(`${dir}/${file}`, "utf8"))
        db.run("INSERT INTO _migrations (name) VALUES (?)", [file])
      }
      db.run("INSERT INTO users (id, name, created_at, disabled) VALUES (?, ?, ?, ?)", ["existing", "Existing", "2026-09-20", 0])
      db.run("INSERT INTO api_keys (id, name, key, created_at, owner_id) VALUES (?, ?, ?, ?, ?)", ["existing-key", "Existing key", "existing-secret", "2026-09-20", "existing"])
      applyMigrations(db, dir)
      applyMigrations(db, dir)
      expect(db.query("SELECT id, key, owner_id, agent_remote_relay, agent_remote_host_id FROM api_keys").all()).toEqual([
        { id: "existing-key", key: "existing-secret", owner_id: "existing", agent_remote_relay: null, agent_remote_host_id: null },
      ])
      expect(db.query("SELECT owner_id FROM agent_remote_host_key_revocations").all()).toEqual([])
      expect(db.query("SELECT name FROM _migrations WHERE name = '0014_agent_remote_host_keys.sql'").all()).toHaveLength(1)
    } finally { db.close() }
  }, 5000)


  test("authentication time migration preserves logins without trusting token creation or old continuations", () => {
    const db = new Database(":memory:")
    try {
      for (const file of listSql().sort().filter(file => file < "0012_")) db.exec(readFileSync(`${dir}/${file}`, "utf8"))
      db.run("INSERT INTO users (id, name, created_at, disabled) VALUES (?, ?, ?, ?)", ["synthetic", "Synthetic", "2026-09-14", 0])
      db.run("INSERT INTO user_sessions (token, user_id, created_at, expires_at, agent_remote_id) VALUES (?, ?, ?, ?, ?)", ["ses_old", "synthetic", "2026-09-14", "2099-01-01", "old-id"])
      db.run("INSERT INTO agent_remote_continuations (handle_hash, session_id, user_id, issuer, audience, expires_at, authenticated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", ["old-hash", "old-id", "synthetic", "issuer", "audience", 9e12, Date.now()])
      db.exec(readFileSync(`${dir}/0012_session_authentication_time.sql`, "utf8"))
      expect(db.query("SELECT token, authenticated_at FROM user_sessions").get()).toEqual({ token: "ses_old", authenticated_at: null })
      expect(db.query("SELECT handle_hash FROM agent_remote_continuations").all()).toEqual([])
    } finally { db.close() }
  })

  test("every filename carries a unique 4-digit prefix", () => {
    const prefixes: string[] = []
    for (const file of listSql()) {
      const match = /^(\d{4})_/.exec(file)
      expect(match, `${file} must start with a 4-digit prefix`).not.toBeNull()
      const prefix = match?.[1]
      if (prefix !== undefined) prefixes.push(prefix)
    }
    expect(new Set(prefixes).size).toBe(prefixes.length)
  })

  // The Bun bootstrap and D1 built six tables with different column orders, so
  // positional column references resolve differently on each runtime. A 12-step
  // table rebuild written with `INSERT INTO new SELECT * FROM old` would migrate
  // one of them into mismatched columns without raising an error.
  test("no migration relies on column position", () => {
    const strip = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
    const offenders: string[] = []

    for (const file of listSql()) {
      const sql = strip(readFileSync(`${dir}/${file}`, "utf8"))
      if (/\bselect\s+(distinct\s+)?\*/i.test(sql)) offenders.push(`${file}: SELECT * — name every column`)
      // `INSERT INTO t SELECT ...` / `INSERT INTO t VALUES ...` with no column
      // list. `AFTER INSERT ON t` in a trigger header has no INTO and is fine.
      if (/\binsert\s+(or\s+\w+\s+)?into\s+["`[]?\w+["`\]]?\s*(select|values|default)\b/i.test(sql)) {
        offenders.push(`${file}: INSERT without a column list`)
      }
    }

    expect(offenders).toEqual([])
  })

  test("gateway sync upgrade leaves upstreams unsynced and the new column never advances a generation or revision", () => {
    const db = new Database(":memory:")
    try {
      db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY)")
      for (const file of listSql().sort().filter(file => file < "0025_")) {
        db.exec(readFileSync(`${dir}/${file}`, "utf8"))
        db.run("INSERT INTO _migrations (name) VALUES (?)", [file])
      }
      db.run("INSERT INTO upstreams (id, owner_id, provider, name, created_at, updated_at) VALUES ('u1', 'o', 'copilot', 'c', 'now', 'now')")
      applyMigrations(db, dir)
      applyMigrations(db, dir)
      const row = () => db.query("SELECT sync_source_id, catalog_generation, credential_generation FROM upstreams").get()
      const revision = () => db.query<{ revision: number }, []>("SELECT revision FROM configuration_revision WHERE id=1").get()?.revision ?? -1
      // Earlier migrations already advance the generation once (row_incarnation backfill); 0025 must add nothing.
      const initial = row() as { sync_source_id: string | null; catalog_generation: number; credential_generation: number }
      expect(initial).toMatchObject({ sync_source_id: null, credential_generation: 0 })
      const before = revision()
      db.run("UPDATE upstreams SET sync_source_id = 'ssrc_x'")
      expect(row()).toEqual({ ...initial, sync_source_id: "ssrc_x" })
      expect(revision()).toBe(before)
      db.run("INSERT INTO sync_sources (id, owner_id, origin, device_id, secret) VALUES ('a', 'o', 'https://c.example', 'sdv_x', 'sds_x')")
      expect(() => db.run("INSERT INTO sync_sources (id, owner_id, origin, device_id, secret) VALUES ('b', 'o', 'https://c.example', 'sdv_x', 'sds_x')")).toThrow()
      expect(() => db.run("INSERT INTO sync_devices (id, owner_id, label, secret_hash, created_at) VALUES ('short', 'o', 'x', 'h', 'now')")).toThrow()
      expect(db.query("SELECT name FROM _migrations WHERE name = '0025_gateway_upstream_sync.sql'").all()).toHaveLength(1)
    } finally { db.close() }
  })

  test("telemetry migration creates the tables, enforces constraints and applies once", () => {
    const db = new Database(":memory:")
    try {
      db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY)")
      for (const file of listSql().sort().filter(file => file < "0026_")) {
        db.exec(readFileSync(`${dir}/${file}`, "utf8"))
        db.run("INSERT INTO _migrations (name) VALUES (?)", [file])
      }
      applyMigrations(db, dir)
      applyMigrations(db, dir)
      const id = `tls_${"a".repeat(32)}`
      db.run("INSERT INTO telemetry_sources (id, owner_id, name, key_hash, created_at) VALUES (?, 'o', 'vm', ?, 'now')", [id, "b".repeat(64)])
      expect(db.query("SELECT settings_json, last_push_at FROM telemetry_sources").get()).toEqual({ settings_json: "{}", last_push_at: null })
      expect(() => db.run("INSERT INTO telemetry_sources (id, owner_id, name, key_hash, created_at) VALUES ('short', 'o', 'vm', ?, 'now')", ["c".repeat(64)])).toThrow()
      expect(() => db.run("INSERT INTO telemetry_sources (id, owner_id, name, key_hash, created_at) VALUES (?, 'o', 'vm2', ?, 'now')", [`tls_${"d".repeat(32)}`, "b".repeat(64)])).toThrow()
      const insert = (value: number, unit: string, hour = 3600) =>
        db.run("INSERT INTO telemetry_points (source_id, metric, hour, dims_key, dims_json, value, unit) VALUES (?, 'm', ?, '', '{}', ?, ?)", [id, hour, value, unit])
      insert(1, "bytes")
      expect(() => insert(1, "bytes")).toThrow()
      expect(() => insert(-1, "bytes", 7200)).toThrow()
      expect(() => insert(1, "seconds", 7200)).toThrow()
      insert(1, "ms", 7200)
      expect(db.query("SELECT name FROM _migrations WHERE name = '0026_telemetry.sql'").all()).toHaveLength(1)
    } finally { db.close() }
  })

  // Guards against the failure this corpus already suffered once: schema
  // applied by hand to the live databases, leaving the migrations unable to
  // rebuild production. Regenerate with UPDATE_SCHEMA_BASELINE=1 only when a
  // new migration intentionally changes the schema.
  test("replaying the corpus reproduces the checked-in schema", () => {
    const db = new Database(":memory:")
    applyMigrations(db, dir)
    const actual = snapshot(db)

    if (process.env.UPDATE_SCHEMA_BASELINE === "1") {
      writeFileSync(baselinePath, actual + "\n")
      return
    }
    expect(actual).toBe(readFileSync(baselinePath, "utf8").trimEnd())
  })
})
