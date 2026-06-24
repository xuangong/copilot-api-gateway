/**
 * Per-runtime factory for the responses snapshot store (Cloudflare slice).
 *
 * On Cloudflare Workers, `env.DB` (D1Database) is wrapped in a SqlExecutor
 * shim and handed to `SqliteResponsesSnapshotStore`. D1 is SQLite under the
 * hood, so storing items as JSON TEXT keeps things flat — mirrors the layout
 * of `d1-repo.ts`.
 */
import {
  SqliteResponsesSnapshotStore,
  type ResponsesSnapshotStore,
  type SqlExecutor,
} from '@vnext-llm/responses-store'

interface D1Result<T = Record<string, unknown>> {
  results: T[]
  success: boolean
  meta: Record<string, unknown>
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result>
}

interface D1Database {
  prepare(query: string): D1PreparedStatement
}

function d1Executor(db: D1Database): SqlExecutor {
  const prep = (sql: string, binds: unknown[]): D1PreparedStatement => {
    const s = db.prepare(sql)
    return binds.length > 0 ? s.bind(...binds) : s
  }
  return {
    async all<T = unknown>(sql: string, binds: unknown[]): Promise<T[]> {
      const { results } = await prep(sql, binds).all<T>()
      return (results ?? []) as T[]
    },
    async first<T = unknown>(sql: string, binds: unknown[]): Promise<T | null> {
      return (await prep(sql, binds).first<T>()) as T | null
    },
    async run(sql: string, binds: unknown[]): Promise<{ changes: number }> {
      const result = await prep(sql, binds).run()
      return { changes: (result.meta.changes as number) ?? 0 }
    },
  }
}

export function createD1ResponsesStore(db: D1Database): ResponsesSnapshotStore {
  return new SqliteResponsesSnapshotStore(d1Executor(db))
}
