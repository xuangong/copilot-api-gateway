// vnext/apps/gateway/src/shared/cache/factory.ts
//
// Picks a Cache implementation from runtime bindings + env. Decision tree:
//
//   CACHE_BACKEND=memory  → MemoryCache
//   CACHE_BACKEND=kv      → KvCache (requires env.KV)
//   CACHE_BACKEND=d1      → D1Cache (requires env.DB)
//   (unset, CFW with KV)  → KvCache  (KV is cheaper + lower latency than D1)
//   (unset, has DB only)  → D1Cache  (Docker multi-instance or CFW without KV)
//   (unset, neither)      → MemoryCache (single-process Docker / local bun)
//
// The KV-first preference on CFW is intentional: KV has built-in TTL, and
// our cache keys are eventually-consistent by design (they encode upstream.updatedAt
// so a stale read becomes a fresh miss as soon as the row updates).
import {
  D1Cache,
  KvCache,
  MemoryCache,
  type Cache,
  type CacheSqlExecutor,
  type KVLike,
} from '@vnext/shared-cache'

interface FactoryEnv {
  DB?: { prepare: (sql: string) => { bind: (...v: unknown[]) => unknown; first?: unknown; run?: unknown; all?: unknown } } | unknown
  KV?: KVLike | unknown
}

interface ProcEnv {
  CACHE_BACKEND?: string
}

export function createCacheFromEnv(env: FactoryEnv, proc: ProcEnv): Cache {
  const explicit = proc.CACHE_BACKEND?.trim().toLowerCase()
  if (explicit === 'memory') return new MemoryCache()
  if (explicit === 'kv') {
    if (!env.KV) throw new Error('CACHE_BACKEND=kv but env.KV is missing')
    return new KvCache(env.KV as KVLike)
  }
  if (explicit === 'd1') {
    if (!env.DB) throw new Error('CACHE_BACKEND=d1 but env.DB is missing')
    return new D1Cache(d1Executor(env.DB))
  }
  if (explicit !== undefined && explicit !== '') {
    throw new Error(`Unknown CACHE_BACKEND: ${proc.CACHE_BACKEND}`)
  }
  // No explicit override.
  if (env.KV) return new KvCache(env.KV as KVLike)
  if (env.DB) return new D1Cache(d1Executor(env.DB))
  return new MemoryCache()
}

// Adapts the D1Database `prepare/bind/first/run` shape to the CacheSqlExecutor
// expected by D1Cache. Mirrors the inline adapter in
// `apps/gateway/src/shared/runtime/responses-store-factory.ts`.
function d1Executor(db: unknown): CacheSqlExecutor {
  interface D1 { prepare(sql: string): D1Stmt }
  interface D1Stmt {
    bind(...values: unknown[]): D1Stmt
    first<T = unknown>(): Promise<T | null>
    run(): Promise<{ meta?: { changes?: number } }>
  }
  const d1 = db as D1
  const prep = (sql: string, binds: unknown[]): D1Stmt => {
    const s = d1.prepare(sql)
    return binds.length > 0 ? s.bind(...binds) : s
  }
  return {
    async first<T = unknown>(sql: string, binds: unknown[]): Promise<T | null> {
      return await prep(sql, binds).first<T>()
    },
    async run(sql: string, binds: unknown[]): Promise<{ changes: number }> {
      const r = await prep(sql, binds).run()
      return { changes: r?.meta?.changes ?? 0 }
    },
  }
}
