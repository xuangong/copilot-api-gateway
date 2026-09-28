import { expect, test } from "bun:test"
import type { PerformanceMetricsGroup } from "@vibe-llm/protocols/common"
import { aggregateMetrics, completePerformanceOptions, countPerformanceOutcomes, DEFAULT_PERFORMANCE_FILTERS, filterPerformanceGroups, summarizeDistribution, togglePerformanceFilter } from "./performance-data"

const group = (patch: Partial<PerformanceMetricsGroup> = {}): PerformanceMetricsGroup => ({
  keyId: "key", incomingModel: "alias", model: "target", upstream: "up", sourceApi: "messages", targetApi: "responses",
  stream: true, runtimeLocation: "cloudflare", outcome: "success", inputBucket: "0-1k", cacheStatus: "hit", reasoningEffort: "high",
  requests: 1, metrics: {}, ...patch,
})

test("merges samples and histograms rather than averaging group means or percentiles", () => {
  const metrics = aggregateMetrics([
    group({ metrics: { ttftMs: { count: 1, sum: 100, min: 100, max: 100, buckets: [{ upper: 100, count: 1 }] } } }),
    group({ requests: 9, metrics: { ttftMs: { count: 9, sum: 1800, min: 200, max: 200, buckets: [{ upper: 200, count: 9 }] } } }),
    group({ requests: 50 }),
  ])
  expect(summarizeDistribution(metrics.ttftMs)).toEqual({ count: 10, mean: 190, p50: 200, p95: 200, max: 200 })
  expect(summarizeDistribution(metrics.upstreamTps)).toEqual({ count: 0, mean: null, p50: null, p95: null, max: null })
})

test("zero is a measurement while absent metrics stay uncollected", () => {
  expect(summarizeDistribution({ count: 1, sum: 0, min: 0, max: 0, buckets: [{ upper: 0, count: 1 }] }).mean).toBe(0)
  expect(summarizeDistribution(undefined).mean).toBeNull()
})

test("filters every comparison dimension and preserves incoming versus target model identity", () => {
  const rows: [PerformanceMetricsGroup, PerformanceMetricsGroup] = [group(), group({ outcome: "cancelled", stream: false, model: "other", incomingModel: "other-alias" })]
  expect(filterPerformanceGroups(rows, { outcome: ["success"], mode: ["stream"], incomingModel: ["alias"], model: ["target"] })).toEqual([rows[0]])
  for (const field of ["keyId", "incomingModel", "model", "upstream", "sourceApi", "targetApi", "runtimeLocation", "inputBucket", "cacheStatus", "reasoningEffort"] as const) {
    expect(filterPerformanceGroups(rows, { [field]: ["missing"] })).toEqual([])
  }
  expect(filterPerformanceGroups(rows, { outcome: ["cancelled"], mode: ["sync"] })).toEqual([rows[1]])
})

test("defaults select success and stream; empty arrays mean all", () => {
  const rows = [group(), group({ outcome: "error" }), group({ stream: false }), group({ outcome: "cancelled", stream: false })]
  expect(DEFAULT_PERFORMANCE_FILTERS).toEqual({ outcome: ["success"], mode: ["stream"] })
  expect(filterPerformanceGroups(rows, DEFAULT_PERFORMANCE_FILTERS)).toEqual(rows.slice(0, 1))
  expect(filterPerformanceGroups(rows, { outcome: [], mode: [] })).toEqual(rows)
  expect(togglePerformanceFilter(["success"], "error")).toEqual(["success", "error"])
  expect(togglePerformanceFilter(["success", "error"], "success")).toEqual(["error"])
  expect(togglePerformanceFilter(["success"], "success")).toEqual([])
})

test("ORs choices within dimensions and ANDs across dimensions, including response mode", () => {
  const rows = [
    group({ model: "a", upstream: "up-a", requests: 11 }),
    group({ model: "b", upstream: "up-a", requests: 13 }),
    group({ model: "a", upstream: "up-a", outcome: "error", requests: 17 }),
    group({ model: "b", upstream: "up-a", outcome: "cancelled", requests: 19 }),
    group({ model: "a", upstream: "up-a", stream: false, requests: 23 }),
    group({ model: "b", upstream: "up-b", requests: 29 }),
    group({ model: "unknown", upstream: "up-a", requests: 37 }),
  ]
  const filters = { model: ["a", "b"], upstream: ["up-a"], outcome: ["success", "error"], mode: ["stream"] }
  expect(filterPerformanceGroups(rows, filters).reduce((sum, row) => sum + row.requests, 0)).toBe(41)
  expect(filterPerformanceGroups(rows, { ...filters, model: [] }).reduce((sum, row) => sum + row.requests, 0)).toBe(78)
  expect(filterPerformanceGroups(rows, { ...filters, model: ["unknown"] }).reduce((sum, row) => sum + row.requests, 0)).toBe(37)
  expect(filterPerformanceGroups(rows, { mode: ["stream", "sync"], outcome: [] })).toEqual(rows)
  expect(countPerformanceOutcomes(rows, filters)).toEqual({ success: 24, error: 17, cancelled: 19 })
  expect(countPerformanceOutcomes(rows, { ...filters, outcome: ["error"] })).toEqual({ success: 24, error: 17, cancelled: 19 })
  expect(countPerformanceOutcomes(rows, { ...filters, model: ["a"] })).toEqual({ success: 11, error: 17, cancelled: 0 })
})

test("selected stale options remain labeled and removable through empty refresh data", () => {
  const selected = ["key-1"]
  const remembered = { "key-1": "Named key" }
  expect(completePerformanceOptions([], selected, remembered)).toEqual([{ value: "key-1", label: "Named key" }])
  expect(completePerformanceOptions([{ value: "key-2", label: "Another key" }], selected, remembered)).toEqual([
    { value: "key-2", label: "Another key" }, { value: "key-1", label: "Named key" },
  ])
  expect(completePerformanceOptions([], ["unknown"], { unknown: "Not collected" })).toEqual([{ value: "unknown", label: "Not collected" }])
  expect(completePerformanceOptions([], togglePerformanceFilter(selected, "key-1"), remembered)).toEqual([])
})
