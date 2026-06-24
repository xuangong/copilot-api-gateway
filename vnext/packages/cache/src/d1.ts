import type { Cache } from './types.ts'

/**
 * The subset of `SqlExecutor` we need. We redeclare it here (instead of
 * importing from `apps/gateway/src/shared/repo/shared/executor.ts`) so this
 * package stays repo-shape-agnostic and can be reused by other workspaces.
 * The gateway bootstrap adapts its existing executors to this shape.
 */
export interface CacheSqlExecutor {
  first<T = unknown>(sql: string, binds: unknown[]): Promise<T | null>
  run(sql: string, binds: unknown[]): Promise<{ changes: number }>
}

interface Row { value_json: string; expires_at: number }

/**
 * SQLite/D1-backed cache. Stores `(key, value_json, expires_at_ms)` with a
 * unique key. Reads filter expired rows in SQL so an unswept row past its TTL
 * still misses correctly. GC runs probabilistically on read: with probability
 * `gcProbability` (default 1%), a `DELETE WHERE expires_at < now` sweep fires
 * after the read completes. This avoids needing a cron worker while keeping
 * the table bounded.
 *
 * Why probabilistic instead of deterministic per N calls: a counter would need
 * to live somewhere mutable; in CFW that means another KV/D1 hop. Random GC is
 * memory-only and converges on the same amortized cost.
 */
export class D1Cache implements Cache {
  constructor(
    private exec: CacheSqlExecutor,
    private clock: () => number = () => Date.now(),
    private gcProbability: number = 0.01,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const now = this.clock()
    let row: Row | null = null
    try {
      row = await this.exec.first<Row>(
        'SELECT value_json, expires_at FROM cache_kv WHERE key = ?',
        [key],
      )
    } catch (err) {
      console.warn('[D1Cache] get failed', { key, err: String(err) })
      return null
    }
    this.maybeSweep(now)
    if (!row) return null
    if (row.expires_at <= now) return null
    try {
      return JSON.parse(row.value_json) as T
    } catch {
      return null
    }
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    const expiresAt = this.clock() + ttlSec * 1000
    try {
      // SQLite UPSERT. D1 supports the same syntax.
      await this.exec.run(
        `INSERT INTO cache_kv (key, value_json, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, expires_at = excluded.expires_at`,
        [key, JSON.stringify(value), expiresAt],
      )
    } catch (err) {
      console.warn('[D1Cache] set failed', { key, err: String(err) })
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.exec.run('DELETE FROM cache_kv WHERE key = ?', [key])
    } catch (err) {
      console.warn('[D1Cache] delete failed', { key, err: String(err) })
    }
  }

  private maybeSweep(now: number): void {
    if (Math.random() >= this.gcProbability) return
    // Fire-and-forget: we don't await so the read latency isn't affected, but
    // we still log failures.
    this.exec.run('DELETE FROM cache_kv WHERE expires_at < ?', [now]).catch((err) => {
      console.warn('[D1Cache] gc sweep failed', { err: String(err) })
    })
  }
}
