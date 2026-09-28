import { afterEach, expect, test } from "bun:test"
import { getMonthUsageTotal } from "./keys"
import type { UsageOverviewMetrics } from "./usage"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test("selected-key quota requests the direct total for the exact UTC month", async () => {
  const calls: URL[] = []
  const total: UsageOverviewMetrics = { requests: 3, input: 4, output: 5, cacheRead: 6, cacheCreation: 7, costUSD: 0.02,
    hasRecords: true, unpricedTokens: 0, unpricedDimensionRows: 0, observedDimensions: ["input"] }
  globalThis.fetch = Object.assign(async (input: URL | RequestInfo) => {
    calls.push(new URL(String(input), "http://localhost"))
    return new Response(JSON.stringify({ total, buckets: [{ requests: 999 }], breakdown: { rows: [{ requests: 999 }] } }),
      { headers: { "content-type": "application/json" } })
  }, originalFetch)
  const result = await getMonthUsageTotal("a/b", new Date("2024-12-31T23:59:59Z"))
  expect(result).toEqual(total)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.pathname).toBe("/api/token-usage/overview")
  expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toEqual({
    start: "2024-12-01T00", end: "2025-01-01T00", key_id: "a/b", bucket: "day", axis: "key", limit: "1",
  })
})
