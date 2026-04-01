/**
 * Unit tests for KV storage
 */
import { describe, test, expect, beforeEach } from "bun:test"

import { KVStorage, STORAGE_KEYS } from "../src/storage"

// Mock KVNamespace implementation for testing
class MockKVNamespace {
  private store = new Map<string, { value: string; expiration?: number }>()

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key)
    if (!entry) return null

    // Check expiration
    if (entry.expiration && Date.now() / 1000 > entry.expiration) {
      this.store.delete(key)
      return null
    }

    return entry.value
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    const entry: { value: string; expiration?: number } = { value }
    if (options?.expirationTtl) {
      entry.expiration = Date.now() / 1000 + options.expirationTtl
    }
    this.store.set(key, entry)
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }
}

describe("KVStorage", () => {
  let mockKV: MockKVNamespace
  let storage: KVStorage

  beforeEach(() => {
    mockKV = new MockKVNamespace()
    storage = new KVStorage(mockKV as unknown as KVNamespace)
  })

  test("get returns null for non-existent key", async () => {
    const result = await storage.get("non-existent")

    expect(result).toBeNull()
  })

  test("set and get basic value", async () => {
    await storage.set("test-key", "test-value")

    const result = await storage.get("test-key")

    expect(result).toBe("test-value")
  })

  test("set overwrites existing value", async () => {
    await storage.set("test-key", "value1")
    await storage.set("test-key", "value2")

    const result = await storage.get("test-key")

    expect(result).toBe("value2")
  })

  test("delete removes key", async () => {
    await storage.set("test-key", "test-value")
    await storage.delete("test-key")

    const result = await storage.get("test-key")

    expect(result).toBeNull()
  })

  test("delete non-existent key does not throw", async () => {
    await expect(storage.delete("non-existent")).resolves.toBeUndefined()
  })

  test("handles empty string value", async () => {
    await storage.set("empty", "")

    const result = await storage.get("empty")

    expect(result).toBe("")
  })

  test("handles large values", async () => {
    const largeValue = "x".repeat(100000)
    await storage.set("large", largeValue)

    const result = await storage.get("large")

    expect(result).toBe(largeValue)
  })

  test("handles special characters in values", async () => {
    const specialValue = "Hello\nWorld\t\"Special\" 'Characters' 中文"
    await storage.set("special", specialValue)

    const result = await storage.get("special")

    expect(result).toBe(specialValue)
  })
})

describe("STORAGE_KEYS", () => {
  test("has expected keys defined", () => {
    expect(STORAGE_KEYS.GITHUB_TOKEN).toBeDefined()
    expect(STORAGE_KEYS.COPILOT_TOKEN).toBeDefined()
    expect(STORAGE_KEYS.COPILOT_TOKEN_EXPIRES).toBeDefined()
  })

  test("keys are strings", () => {
    expect(typeof STORAGE_KEYS.GITHUB_TOKEN).toBe("string")
    expect(typeof STORAGE_KEYS.COPILOT_TOKEN).toBe("string")
    expect(typeof STORAGE_KEYS.COPILOT_TOKEN_EXPIRES).toBe("string")
  })
})
