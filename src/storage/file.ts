import type { IStorage } from "./interface"

interface CacheEntry {
  value: string
  expiresAt?: number // Unix timestamp in ms
}

type CacheData = Record<string, CacheEntry>

/**
 * File-based storage implementation using Bun.file()
 * Stores data in a JSON file with TTL support
 */
export class FileStorage implements IStorage {
  private data: CacheData = {}
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private filePath: string) {}

  /**
   * Initialize storage by loading existing data from file
   */
  async init(): Promise<void> {
    const file = Bun.file(this.filePath)
    if (await file.exists()) {
      try {
        this.data = await file.json()
      } catch {
        // File corrupted or empty, start fresh
        this.data = {}
      }
    }
  }

  async get(key: string): Promise<string | null> {
    const entry = this.data[key]
    if (!entry) return null

    // Check expiration
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      delete this.data[key]
      this.scheduleFlush()
      return null
    }

    return entry.value
  }

  async set(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    const entry: CacheEntry = { value }
    if (options?.expirationTtl) {
      entry.expiresAt = Date.now() + options.expirationTtl * 1000
    }
    this.data[key] = entry
    this.scheduleFlush()
  }

  async delete(key: string): Promise<void> {
    delete this.data[key]
    this.scheduleFlush()
  }

  /**
   * Debounced flush to avoid excessive file writes
   */
  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer) return

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null
      if (this.dirty) {
        await this.flush()
      }
    }, 100)
  }

  /**
   * Immediately write data to file
   */
  async flush(): Promise<void> {
    this.dirty = false
    await Bun.write(this.filePath, JSON.stringify(this.data, null, 2))
  }
}
