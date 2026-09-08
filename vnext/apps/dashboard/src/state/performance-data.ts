import type { MetricDistribution, PerformanceMetricName, PerformanceMetricsGroup } from "@vibe-llm/protocols/common"

export type PerformanceFilters = Partial<Record<
  "keyId" | "incomingModel" | "model" | "upstream" | "sourceApi" | "targetApi" | "runtimeLocation" |
  "outcome" | "inputBucket" | "cacheStatus" | "reasoningEffort" | "mode", string
>>

export function filterPerformanceGroups(groups: PerformanceMetricsGroup[], filters: PerformanceFilters): PerformanceMetricsGroup[] {
  return groups.filter(group => Object.entries(filters).every(([field, value]) => {
    if (!value) return true
    if (field === "mode") return group.stream === (value === "stream")
    return group[field as keyof PerformanceMetricsGroup] === value
  }))
}

export function aggregateMetrics(groups: PerformanceMetricsGroup[]): Partial<Record<PerformanceMetricName, MetricDistribution>> {
  const result: Partial<Record<PerformanceMetricName, MetricDistribution>> = {}
  for (const group of groups) {
    for (const [name, next] of Object.entries(group.metrics) as Array<[PerformanceMetricName, MetricDistribution]>) {
      if (!next || next.count === 0) continue
      const current = result[name]
      if (!current) {
        result[name] = { ...next, buckets: next.buckets.map(bucket => ({ ...bucket })) }
        continue
      }
      current.count += next.count
      current.sum += next.sum
      current.min = Math.min(current.min, next.min)
      current.max = Math.max(current.max, next.max)
      const buckets = new Map(current.buckets.map(bucket => [bucket.upper, bucket.count]))
      for (const bucket of next.buckets) buckets.set(bucket.upper, (buckets.get(bucket.upper) ?? 0) + bucket.count)
      current.buckets = [...buckets].map(([upper, count]) => ({ upper, count }))
    }
  }
  return result
}

export function summarizeDistribution(distribution: MetricDistribution | undefined) {
  const count = distribution?.count ?? 0
  const percentile = (rank: number): number | null => {
    if (!distribution || count === 0) return null
    const target = Math.ceil(count * rank)
    let seen = 0
    for (const bucket of [...distribution.buckets].sort((a, b) => a.upper - b.upper)) {
      seen += bucket.count
      if (seen >= target) return bucket.upper
    }
    return null
  }
  return {
    count,
    mean: distribution && count ? distribution.sum / count : null,
    p50: percentile(0.5), p95: percentile(0.95),
    max: distribution && count ? distribution.max : null,
  }
}

export function comparisonGroups(groups: PerformanceMetricsGroup[]) {
  const result = new Map<string, { model: string; upstream: string | null; sourceApi: string; targetApi: string; rows: PerformanceMetricsGroup[] }>()
  for (const group of groups) {
    const id = JSON.stringify([group.model, group.upstream, group.sourceApi, group.targetApi])
    const entry = result.get(id) ?? { model: group.model, upstream: group.upstream, sourceApi: group.sourceApi, targetApi: group.targetApi, rows: [] }
    entry.rows.push(group)
    result.set(id, entry)
  }
  return [...result].map(([id, entry]) => ({
    id, ...entry, requests: entry.rows.reduce((sum, group) => sum + group.requests, 0), metrics: aggregateMetrics(entry.rows),
  })).sort((a, b) => b.requests - a.requests)
}

export function formatPerformanceValue(value: number | null, metric: PerformanceMetricName, unknown: string): string {
  if (value === null || !Number.isFinite(value)) return unknown
  if (metric.endsWith("Tps")) return value.toLocaleString(undefined, { maximumFractionDigits: 1 }) + " tok/s"
  if (metric.endsWith("Tokens")) return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return value >= 1000 ? (value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " s" : Math.round(value) + " ms"
}
