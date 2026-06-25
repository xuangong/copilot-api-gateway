// Per-runtime factory for the responses snapshot store (Bun slice).
//
// Accepts the platform-neutral `BunSqliteDatabase` adapter (not raw
// `bun:sqlite.Database`) so the gateway can stay runtime-agnostic. The Bun
// runtime entry creates the BunSqliteDatabase once at boot and passes it
// here. T6 (entry-bun rewrite) is what flips the calling convention; until
// then the gateway-side residual in
// `packages/gateway/src/shared/runtime/responses-store-factory.ts` wraps a
// raw Database in BunSqliteDatabase before calling this function.
import {
  SqliteResponsesSnapshotStore,
  type ResponsesSnapshotStore,
  type SqlExecutor,
} from "@vibe-llm/responses-store"
import type { BunSqliteDatabase } from "./bun-sqlite-database.ts"

function toExecutor(db: BunSqliteDatabase): SqlExecutor {
  const prep = (sql: string, binds: unknown[]) => {
    const stmt = db.prepare(sql)
    return binds.length > 0 ? stmt.bind(...binds) : stmt
  }
  return {
    async all<T = unknown>(sql: string, binds: unknown[]): Promise<T[]> {
      const { results } = await prep(sql, binds).all<T extends Record<string, unknown> ? T : never>()
      return (results ?? []) as T[]
    },
    async first<T = unknown>(sql: string, binds: unknown[]): Promise<T | null> {
      return (await prep(sql, binds).first<T extends Record<string, unknown> ? T : never>()) as T | null
    },
    async run(sql: string, binds: unknown[]): Promise<{ changes: number }> {
      const result = await prep(sql, binds).run()
      return { changes: result.meta.changes ?? 0 }
    },
  }
}

export function createBunResponsesStore(db: BunSqliteDatabase): ResponsesSnapshotStore {
  return new SqliteResponsesSnapshotStore(toExecutor(db))
}
