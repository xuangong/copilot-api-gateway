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
