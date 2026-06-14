/**
 * Adapts Bun's native `bun:sqlite` Database to the runtime-neutral
 * `SqlDatabase` interface defined in `@vnext/platform`. The shape mirrors
 * Cloudflare D1 (prepare → bind → first/all/run) so the gateway can switch
 * sql backends without knowing which runtime it's running under.
 *
 * Why an adapter instead of teaching the gateway about bun:sqlite directly:
 * the gateway must stay runtime-agnostic. The platform-bun app owns the
 * "translate bun:sqlite into the SqlDatabase contract" responsibility, so
 * any future runtime (Deno, Node + better-sqlite3, etc.) just writes its
 * own adapter.
 */
import type { Database, Statement } from "bun:sqlite"
import type {
  SqlDatabase,
  SqlPreparedStatement,
  SqlResult,
} from "@vnext/platform"

class BunSqlitePrepared implements SqlPreparedStatement {
  private binds: unknown[] = []
  constructor(private stmt: Statement) {}

  bind(...values: unknown[]): SqlPreparedStatement {
    this.binds = values
    return this
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.stmt.get(...(this.binds as never[]))
    return (row ?? null) as T | null
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    const rows = this.stmt.all(...(this.binds as never[])) as T[]
    return { results: rows, success: true, meta: { changes: 0 } }
  }

  async run(): Promise<SqlResult> {
    const info = this.stmt.run(...(this.binds as never[]))
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes ?? 0) },
    }
  }
}

export class BunSqliteDatabase implements SqlDatabase {
  constructor(public readonly raw: Database) {}

  prepare(query: string): SqlPreparedStatement {
    return new BunSqlitePrepared(this.raw.prepare(query))
  }

  async exec(sql: string): Promise<unknown> {
    this.raw.exec(sql)
    return undefined
  }
}
