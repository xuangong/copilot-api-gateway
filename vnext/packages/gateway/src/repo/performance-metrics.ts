import { isPerformanceMetricName, type MetricDistribution, type PerformanceMetricsGroup, type PerformanceMetricsResponse } from "@vibe-llm/protocols/common"
import type { ApiKeyId } from "./branded-ids"
import type { SqlExecutor } from "./shared/executor"

export interface PerformanceMetricsRepo {
  record(input: { hour: string; group: PerformanceMetricsGroup; legacyRecorded: boolean }): Promise<void>
  query(opts: { start: string; end: string; keyId?: ApiKeyId; keyIds?: ApiKeyId[] }): Promise<PerformanceMetricsResponse>
  deleteAll(): Promise<void>
}

type Dimensions = Omit<PerformanceMetricsGroup, "keyId" | "keyName" | "requests" | "metrics">
interface Row { key_id: string; dimensions: string; metric: string; upper: number; count: number; sum: number; min: number; max: number }

export class SharedPerformanceMetricsRepo implements PerformanceMetricsRepo {
  constructor(private readonly x: SqlExecutor) {}
  async record({ hour, group, legacyRecorded }: { hour: string; group: PerformanceMetricsGroup; legacyRecorded: boolean }): Promise<void> {
    // Explicit order is part of the identity. Never serialize caller property order.
    const dimensions: Dimensions = {
      incomingModel: group.incomingModel, model: group.model, upstream: group.upstream,
      sourceApi: group.sourceApi, targetApi: group.targetApi, stream: group.stream,
      runtimeLocation: group.runtimeLocation, outcome: group.outcome, inputBucket: group.inputBucket,
      cacheStatus: group.cacheStatus, reasoningEffort: group.reasoningEffort,
    }
    const rows = [{ metric: "__requests", upper: -1, count: group.requests, sum: legacyRecorded ? group.requests : 0, min: 0, max: 0 }]
    for (const [metric, d] of Object.entries(group.metrics)) {
      if (d.count <= 0) continue
      rows.push({ metric, upper: -1, count: d.count, sum: d.sum, min: d.min, max: d.max })
      for (const b of d.buckets) rows.push({ metric, upper: b.upper, count: b.count, sum: 0, min: 0, max: 0 })
    }
    await this.x.run(`INSERT INTO performance_metrics (hour, key_id, dimensions, metric, upper, count, sum, min, max)
      SELECT ?, ?, ?, json_extract(value, '$.metric'), json_extract(value, '$.upper'), json_extract(value, '$.count'), json_extract(value, '$.sum'), json_extract(value, '$.min'), json_extract(value, '$.max') FROM json_each(?) WHERE true
      ON CONFLICT (hour, key_id, dimensions, metric, upper) DO UPDATE SET
      count = count + excluded.count, sum = sum + excluded.sum, min = MIN(min, excluded.min), max = MAX(max, excluded.max)`, [hour, group.keyId, JSON.stringify(dimensions), JSON.stringify(rows)])
  }

  async query(opts: { start: string; end: string; keyId?: ApiKeyId; keyIds?: ApiKeyId[] }): Promise<PerformanceMetricsResponse> {
    const empty: PerformanceMetricsResponse = { version: 2, groups: [], legacyRequests: 0 }
    if (opts.keyIds?.length === 0) return empty
    const filters = ["hour >= ?", "hour <= ?"]
    const binds: unknown[] = [opts.start, opts.end]
    if (opts.keyIds) { filters.push("key_id IN (SELECT value FROM json_each(?))"); binds.push(JSON.stringify(opts.keyIds)) }
    if (opts.keyId) { filters.push("key_id = ?"); binds.push(opts.keyId) }
    const where = filters.join(" AND ")
    const rows = await this.x.all<Row>(`SELECT key_id, dimensions, metric, upper, SUM(count) AS count, SUM(sum) AS sum, MIN(min) AS min, MAX(max) AS max FROM performance_metrics WHERE ${where} GROUP BY key_id, dimensions, metric, upper ORDER BY key_id, dimensions, metric, upper`, binds)
    const groups = new Map<string, PerformanceMetricsGroup>()
    let collectedLegacy = 0
    for (const row of rows) {
      const key = JSON.stringify([row.key_id, row.dimensions])
      let group = groups.get(key)
      if (!group) {
        group = { ...JSON.parse(row.dimensions) as Dimensions, keyId: row.key_id, requests: 0, metrics: {} }
        groups.set(key, group)
      }
      if (row.metric === "__requests") { group.requests = row.count; collectedLegacy += row.sum; continue }
      // Retain retired metrics in storage for audit, without mixing their
      // incompatible formula into the current API or new distributions.
      if (!isPerformanceMetricName(row.metric)) continue
      const distribution: MetricDistribution = group.metrics[row.metric] ??= { count: 0, sum: 0, min: 0, max: 0, buckets: [] }
      if (row.upper === -1) Object.assign(distribution, { count: row.count, sum: row.sum, min: row.min, max: row.max })
      else distribution.buckets.push({ upper: row.upper, count: row.count })
    }
    const legacy = await this.x.first<{ requests: number | null }>(`SELECT SUM(requests) AS requests FROM performance_summary WHERE ${where} AND metric_scope = 'request_total' AND operation IS NULL`, binds)
    return { version: 2, groups: [...groups.values()], legacyRequests: Math.max(0, (legacy?.requests ?? 0) - collectedLegacy) }
  }

  async deleteAll(): Promise<void> { await this.x.run("DELETE FROM performance_metrics", []) }
}
