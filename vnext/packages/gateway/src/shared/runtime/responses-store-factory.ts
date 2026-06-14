/**
 * Temporary residual file: holds only `createBunResponsesStore`.
 *
 * The Cloudflare D1 sibling moved to `apps/platform-cloudflare/src/
 * responses-store-factory.ts` in plan A3 T3. The Bun half stays here so
 * `packages/gateway/entry-bun.ts` keeps compiling until T4 relocates this
 * implementation to `apps/platform-bun/src/` and rewrites entry-bun.
 *
 * DO NOT add new code here.
 */
import {
  SqliteResponsesSnapshotStore,
  type ResponsesSnapshotStore,
  type SqlExecutor,
} from '@vnext/responses-store'

function bunSqliteExecutor(db: import('bun:sqlite').Database): SqlExecutor {
  return {
    async all<T = unknown>(sql: string, binds: unknown[]): Promise<T[]> {
      return db.query(sql).all(...(binds as never[])) as T[]
    },
    async first<T = unknown>(sql: string, binds: unknown[]): Promise<T | null> {
      const row = db.query(sql).get(...(binds as never[]))
      return (row ?? null) as T | null
    },
    async run(sql: string, binds: unknown[]): Promise<{ changes: number }> {
      const info = db.query(sql).run(...(binds as never[]))
      return { changes: Number(info.changes ?? 0) }
    },
  }
}

export function createBunResponsesStore(db: import('bun:sqlite').Database): ResponsesSnapshotStore {
  return new SqliteResponsesSnapshotStore(bunSqliteExecutor(db))
}
