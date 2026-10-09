import { afterEach, expect, test } from "bun:test"
import { getKeyUpstreams, getMonthUsageTotal, patchKey } from "./keys"
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

test("key upstream choices use the key router and preserve disabled safe metadata", async () => {
  const calls: Array<{ path: string; method: string | undefined }> = []
  globalThis.fetch = Object.assign(async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ path: String(input), method: init?.method })
    return Response.json({ upstreams: [
      { id: "up-b", name: "Disabled", provider: "custom", enabled: false },
      { id: "up-a", name: "Enabled", provider: "copilot", enabled: true },
    ] })
  }, originalFetch)
  expect(await getKeyUpstreams("key/a b")).toEqual([
    { id: "up-b", name: "Disabled", provider: "custom", enabled: false },
    { id: "up-a", name: "Enabled", provider: "copilot", enabled: true },
  ])
  expect(calls).toEqual([{ path: "/api/keys/key%2Fa%20b/upstreams", method: "GET" }])
})

test.each([{ ids: null }, { ids: [] }, { ids: ["up-b", "up-a"] }])("key upstream PATCH preserves the exact selected scope %j", async ({ ids }) => {
  const calls: Array<{ path: string; method: string | undefined; body: unknown }> = []
  globalThis.fetch = Object.assign(async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ path: String(input), method: init?.method, body: JSON.parse(String(init?.body)) })
    return Response.json({ id: "key/a", upstream_ids: ids })
  }, originalFetch)
  const selectedIds = ids === null ? null : [...ids]
  const result = await patchKey("key/a", { upstream_ids: selectedIds })
  expect(result.upstream_ids).toEqual(selectedIds)
  expect(calls).toEqual([{ path: "/api/keys/key%2Fa", method: "PATCH", body: { upstream_ids: ids } }])
})

test("upstream choice errors remain retryable instead of becoming an empty successful list", async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ error: "unavailable" }, { status: 503 }), originalFetch)
  await expect(getKeyUpstreams("key-a")).rejects.toThrow("unavailable")
})
