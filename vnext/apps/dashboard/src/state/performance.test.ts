import { expect, test } from "bun:test"
import type { PerformanceMetricsGroup } from "@vibe-llm/protocols/common"
import { aggregateMetrics, filterPerformanceGroups, summarizeDistribution } from "./performance-data"

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
  expect(filterPerformanceGroups(rows, { outcome: "success", mode: "stream", incomingModel: "alias", model: "target" })).toEqual([rows[0]])
  for (const field of ["keyId", "incomingModel", "model", "upstream", "sourceApi", "targetApi", "runtimeLocation", "inputBucket", "cacheStatus", "reasoningEffort"] as const) {
    expect(filterPerformanceGroups(rows, { [field]: "missing" })).toEqual([])
  }
  expect(filterPerformanceGroups(rows, { outcome: "cancelled", mode: "sync" })).toEqual([rows[1]])
})
