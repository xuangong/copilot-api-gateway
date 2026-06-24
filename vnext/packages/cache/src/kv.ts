import type { Cache } from './types.ts'

/**
 * Minimal subset of Cloudflare's `KVNamespace` that we actually call. Defining
 * it here keeps `@vnext-gateway/cache` free of `@cloudflare/workers-types`
 * (which would pull a dom-shaped global into every workspace consumer).
 */
export interface KVLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * KV-backed cache. Reads/writes are JSON; ttl is forwarded as `expirationTtl`
 * so Cloudflare evicts at the edge without us needing GC. Errors are swallowed
 * (logged via `console.warn` so they show up in `wrangler tail`) — the gateway
 * must continue to serve from upstream + L1 even when KV is degraded.
 *
 * KV's minimum expirationTtl is 60 seconds; we reject anything shorter at
 * construction-time-of-the-call so the failure mode is loud during dev
 * instead of a silent 400 from the KV API at runtime.
 */
export class KvCache implements Cache {
  constructor(private kv: KVLike) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.kv.get(key)
      if (raw === null) return null
      return JSON.parse(raw) as T
    } catch (err) {
      console.warn('[KvCache] get failed', { key, err: String(err) })
      return null
    }
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    if (ttlSec < 60) throw new Error(`KvCache: ttlSec must be >= 60, got ${ttlSec}`)
    try {
      await this.kv.put(key, JSON.stringify(value), { expirationTtl: ttlSec })
    } catch (err) {
      console.warn('[KvCache] put failed', { key, err: String(err) })
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.kv.delete(key)
    } catch (err) {
      console.warn('[KvCache] delete failed', { key, err: String(err) })
    }
  }
}
