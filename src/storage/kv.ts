import type { IStorage } from "./interface"

// Cloudflare KV Storage implementation
export class KVStorage implements IStorage {
  constructor(private kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return this.kv.get(key)
  }

  async set(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    await this.kv.put(key, value, options)
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key)
  }
}
