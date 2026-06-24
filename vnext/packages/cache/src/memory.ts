import type { Cache } from './types.ts'

interface Entry { value: string; expiresAt: number }

/**
 * In-process cache for a single Node/Bun process or a single CFW isolate.
 * Stores values as serialized JSON so that swapping in a distributed backend
 * (KV/D1) doesn't change observed semantics. The optional `clock` parameter
 * exists so tests can advance time without sleeping.
 */
export class MemoryCache implements Cache {
  private store = new Map<string, Entry>()

  constructor(private clock: () => number = () => Date.now()) {}

  async get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key)
    if (!hit) return null
    if (hit.expiresAt <= this.clock()) {
      this.store.delete(key)
      return null
    }
    return JSON.parse(hit.value) as T
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    this.store.set(key, {
      value: JSON.stringify(value),
      expiresAt: this.clock() + ttlSec * 1000,
    })
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}
