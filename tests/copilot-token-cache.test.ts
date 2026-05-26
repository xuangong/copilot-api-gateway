import { afterEach, describe, expect, test, mock } from "bun:test"

import { _resetCopilotTokenCacheForTests, getCachedCopilotToken, invalidateCopilotToken } from "../src/services/github/copilot-token-cache"

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  _resetCopilotTokenCacheForTests()
})

function mockTokenExchange(): { fetchSpy: ReturnType<typeof mock>; nextToken: () => string } {
  let counter = 0
  const next = () => `tok-${++counter}`
  const fetchSpy = mock(async () => {
    const token = next()
    return new Response(
      JSON.stringify({ token, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: 1800 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  })
  globalThis.fetch = fetchSpy as unknown as typeof fetch
  return { fetchSpy, nextToken: next }
}

describe("copilot-token-cache", () => {
  test("L1 in-process cache: second call serves the same token without re-exchanging", async () => {
    const { fetchSpy } = mockTokenExchange()
    const a = await getCachedCopilotToken("gh-1", "individual")
    const b = await getCachedCopilotToken("gh-1", "individual")
    expect(a).toBe(b)
    expect(fetchSpy.mock.calls.length).toBe(1)
  })

  test("different githubToken keys cache separately", async () => {
    mockTokenExchange()
    const a = await getCachedCopilotToken("gh-1", "individual")
    const b = await getCachedCopilotToken("gh-2", "individual")
    expect(a).not.toBe(b)
  })

  test("different accountType for the same githubToken caches separately", async () => {
    mockTokenExchange()
    const a = await getCachedCopilotToken("gh-1", "individual")
    const b = await getCachedCopilotToken("gh-1", "business")
    expect(a).not.toBe(b)
  })

  test("invalidate forces re-exchange on the next call", async () => {
    const { fetchSpy } = mockTokenExchange()
    const first = await getCachedCopilotToken("gh-1", "individual")
    await invalidateCopilotToken("gh-1", "individual")
    const second = await getCachedCopilotToken("gh-1", "individual")
    expect(first).not.toBe(second)
    expect(fetchSpy.mock.calls.length).toBe(2)
  })

  test("L2 KV: in-process miss reads through to KV and rehydrates L1", async () => {
    const { fetchSpy } = mockTokenExchange()
    const kvStore = new Map<string, string>()
    const kv = {
      get: async (k: string) => kvStore.get(k) ?? null,
      set: async (k: string, v: string) => { kvStore.set(k, v) },
      delete: async (k: string) => { kvStore.delete(k) },
    }
    const first = await getCachedCopilotToken("gh-1", "individual", kv)
    expect(fetchSpy.mock.calls.length).toBe(1)
    expect([...kvStore.keys()].length).toBe(1)

    _resetCopilotTokenCacheForTests() // simulate isolate restart

    const second = await getCachedCopilotToken("gh-1", "individual", kv)
    expect(second).toBe(first) // served from KV, no new exchange
    expect(fetchSpy.mock.calls.length).toBe(1)
  })

  test("invalidate removes the KV entry too", async () => {
    mockTokenExchange()
    const kvStore = new Map<string, string>()
    const kv = {
      get: async (k: string) => kvStore.get(k) ?? null,
      set: async (k: string, v: string) => { kvStore.set(k, v) },
      delete: async (k: string) => { kvStore.delete(k) },
    }
    await getCachedCopilotToken("gh-1", "individual", kv)
    expect([...kvStore.keys()].length).toBe(1)
    await invalidateCopilotToken("gh-1", "individual", kv)
    expect([...kvStore.keys()].length).toBe(0)
  })
})
