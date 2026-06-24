/**
 * Runtime-agnostic key/value cache. Implementations live in `./memory.ts`,
 * `./kv.ts`, `./d1.ts`. Values are JSON-serialized internally.
 *
 * Contract:
 * - `get` returns `null` on miss, on expired entry, or on any transport error
 *   (errors are swallowed — callers must always handle null).
 * - `set` writes with a required ttl in seconds. There is intentionally no
 *   "cache forever" overload; callers must pick a cap.
 * - `delete` is idempotent.
 */
export interface Cache {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, ttlSec: number): Promise<void>
  delete(key: string): Promise<void>
}
