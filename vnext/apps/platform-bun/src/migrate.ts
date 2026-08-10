import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Database } from "bun:sqlite"
import { migrationsDir } from "@vibe-llm/gateway/migrations"

const LEDGER = "_migrations"

const listMigrations = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()

/**
 * Applies every unapplied migration in `dir`, recording each filename in the
 * `_migrations` ledger. Synchronous because `new BunSqliteRepo(db)` is a
 * synchronous constructor.
 *
 * Databases that predate the ledger need no special handling: the corpus was
 * squashed to a baseline of idempotent statements, so replaying it against an
 * existing database only fills in objects that happen to be missing.
 */
export function applyMigrations(db: Database, dir = fileURLToPath(migrationsDir.href)): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER} (name TEXT PRIMARY KEY)`)

  const applied = new Set(db.query<{ name: string }, []>(`SELECT name FROM ${LEDGER}`).all().map((r) => r.name))
  const record = db.prepare(`INSERT INTO ${LEDGER} (name) VALUES (?)`)

  for (const file of listMigrations(dir)) {
    if (applied.has(file)) continue
    // Whole file in one exec: migrations may contain CREATE TRIGGER bodies
    // whose internal semicolons defeat statement splitting.
    const sql = readFileSync(`${dir}/${file}`, "utf8")
    db.exec("BEGIN")
    try {
      db.exec(sql)
      record.run(file)
      db.exec("COMMIT")
    } catch (err) {
      // A hard SQLite error already rolled the transaction back, in which case
      // an explicit ROLLBACK throws and would mask the real cause.
      try {
        db.exec("ROLLBACK")
      } catch {}
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err })
    }
  }
}
