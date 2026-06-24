// Picks a Cache implementation from Bun runtime + env. Decision tree:
//
//   CACHE_BACKEND=memory  → MemoryCache
//   CACHE_BACKEND=d1      → D1Cache backed by the BunSqliteDatabase adapter
//   (unset, has db)       → D1Cache (so multi-process bun deployments share)
//   (unset, no db)        → MemoryCache (single-process docker / dev)
//
// There is no KV path on Bun — KV is a Cloudflare binding. The d1 backend
// here is a misnomer kept for consistency with the shared D1Cache class:
// what's actually wired is SQLite-on-Bun, but the SQL flow is identical
// because D1 is just SQLite under the hood.
import {
  D1Cache,
  MemoryCache,
  type Cache,
  type CacheSqlExecutor,
} from "@vnext/cache"
import type { BunSqliteDatabase } from "./bun-sqlite-database.ts"

export interface BunCacheEnv {
  db?: BunSqliteDatabase
  backend?: string
}

export function createBunCache(env: BunCacheEnv): Cache {
  const explicit = env.backend?.trim().toLowerCase()
  if (explicit === "memory") return new MemoryCache()
  if (explicit === "d1") {
    if (!env.db) throw new Error("CACHE_BACKEND=d1 but no Bun sqlite db was provided")
    return new D1Cache(toCacheExecutor(env.db))
  }
  if (explicit !== undefined && explicit !== "") {
    throw new Error(`Unknown CACHE_BACKEND: ${env.backend}`)
  }
  // No explicit override.
  if (env.db) return new D1Cache(toCacheExecutor(env.db))
  return new MemoryCache()
}

// Wrap the SqlDatabase (BunSqliteDatabase) adapter's prepare/bind/first/run
// shape in the slimmer CacheSqlExecutor interface D1Cache expects. Mirrors
// the d1Executor in platform-cloudflare/src/cache-factory.ts — same pattern,
// just sourced from our local adapter instead of a raw D1Database.
function toCacheExecutor(db: BunSqliteDatabase): CacheSqlExecutor {
  return {
    async first<T = unknown>(sql: string, binds: unknown[]): Promise<T | null> {
      const stmt = db.prepare(sql)
      const bound = binds.length > 0 ? stmt.bind(...binds) : stmt
      return await bound.first<T extends Record<string, unknown> ? T : never>() as T | null
    },
    async run(sql: string, binds: unknown[]): Promise<{ changes: number }> {
      const stmt = db.prepare(sql)
      const bound = binds.length > 0 ? stmt.bind(...binds) : stmt
      const result = await bound.run()
      return { changes: result.meta.changes ?? 0 }
    },
  }
}
