/**
 * Runtime-agnostic key/value cache. Implementations live in `./memory.ts`,
 * `./kv.ts`, `./d1.ts`. Values are JSON-serialized internally.
 *
 * Contract:
 * - `get` returns `null` on miss, on expired entry, or on any transport error
 *   (errors are swallowed — callers must always handle null).
 * - `set` takes a TTL in seconds, or explicit null to retain a snapshot until
 *   it is replaced or deleted. Memory-backed entries still end with the process.
 * - `delete` is idempotent.
 */
export interface Cache {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, ttlSec: number | null): Promise<void>
  delete(key: string): Promise<void>
}
