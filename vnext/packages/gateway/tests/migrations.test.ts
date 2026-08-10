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

describe("migration corpus", () => {
  test("every filename carries a unique 4-digit prefix", () => {
    const prefixes = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => {
        const m = /^(\d{4})_/.exec(f)
        expect(m, `${f} must start with a 4-digit prefix`).not.toBeNull()
        return m![1]!
      })
    expect(new Set(prefixes).size).toBe(prefixes.length)
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
