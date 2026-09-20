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
