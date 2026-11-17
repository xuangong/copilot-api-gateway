import type { UserId } from "./branded-ids.ts"

export type TelemetryUnit = "bytes" | "count" | "ms"

export const TELEMETRY_UNITS: readonly TelemetryUnit[] = ["bytes", "count", "ms"]
export const TELEMETRY_DIMS_RETENTION_DAYS = 90
export const TELEMETRY_PLAIN_RETENTION_DAYS = 400
/** Hourly rollup rows (one per metric and hour) outlive the dimension rows they summarize. */
export const TELEMETRY_ROLLUP_RETENTION_DAYS = 400
export const TELEMETRY_PURGE_CHUNK = 20_000
/** DELETE statements one `deleteExpired` call may issue in total (plus one orphan lookup), well inside the Workers Paid limit of 1000 queries per invocation. */
export const TELEMETRY_PURGE_MAX_CHUNKS = 20
/** At most 22 point INSERT chunks (row cut here, or the byte cut below) + 4 rollup chunks + 20 DELETEs + 1 UPDATE = 47 statements per push, plus 2 auth reads = 49 queries per invocation (Workers Paid allows 1000; the free plan's 50 still fits). */
export const TELEMETRY_INSERT_CHUNK = 1000
/** Serialized (UTF-8) size at which an insert chunk is cut, well under D1's 2 000 000 byte limit for one bound value. */
export const TELEMETRY_INSERT_CHUNK_BYTES = 1_500_000

export interface TelemetrySourceRecord {
  id: string
  ownerId: UserId
  name: string
  /** SHA-256 hex of the push key; the key itself is never stored. */
  keyHash: string
  /** Validated by the routes; stored as JSON. */
  settings: Record<string, unknown>
  createdAt: string
  lastPushAt: string | null
}

/** `hour` is unix seconds at the top of an hour. */
export interface TelemetryPoint {
  metric: string
  hour: number
  dims: Record<string, string>
  value: number
  unit: TelemetryUnit
}

export interface TelemetryMetricInfo {
  metric: string
  unit: TelemetryUnit
  firstHour: number
  lastHour: number
  dimKeys: string[]
}

/** Restricts point rows to those whose dim `key` equals `value`. `key` becomes a JSON path: callers must validate it against the dim-key pattern. */
export interface TelemetryDimFilter { key: string; value: string }
export interface TelemetryHourValue { hour: number; value: number }
export interface TelemetryMetricHourValue extends TelemetryHourValue { metric: string; unit: TelemetryUnit }
export interface TelemetryGroupTotal { key: string; value: number }
export interface TelemetryGroupHours { key: string; points: TelemetryHourValue[] }
export interface TelemetryDimRow { metric: string; hour: number; dims: Record<string, string>; value: number }
export interface TelemetryContribution { dims: Record<string, string>; value: number }
export interface TelemetryHourContribution extends TelemetryContribution { metric: string; hour: number }

export interface TelemetryRepo {
  /** Oldest first. */
  listSources(ownerId: UserId): Promise<TelemetrySourceRecord[]>
  getSource(id: string): Promise<TelemetrySourceRecord | null>
  findSourceByKeyHash(keyHash: string): Promise<TelemetrySourceRecord | null>
  /** Inserts unless the owner already holds `limit` sources. False means the limit was reached. */
  createSourceWithinLimit(source: TelemetrySourceRecord, limit: number): Promise<boolean>
  /** Updates only supplied fields (`settings` replaces the whole object); null when missing or owned by someone else. */
  updateSource(id: string, ownerId: UserId, patch: { name?: string; settings?: Record<string, unknown> }): Promise<TelemetrySourceRecord | null>
  rotateKey(id: string, ownerId: UserId, keyHash: string): Promise<TelemetrySourceRecord | null>
  /** Deletes only the row; its points become orphans that `deleteExpired` purges. False when missing or owned by someone else. */
  deleteSource(id: string, ownerId: UserId): Promise<boolean>
  deleteSourcesByOwner(ownerId: UserId): Promise<void>
  /**
   * Atomically replaces every (metric, hour) present in `points` (and its hourly rollup row, the sum over dims) and stamps `last_push_at`. Empty `points` only stamps.
   * False (and nothing written) when the source no longer exists.
   */
  replaceHours(sourceId: string, points: readonly TelemetryPoint[], nowIso: string): Promise<boolean>
  /** Metrics with data at or after `sinceHour`, read from the hourly rollup by index seeks: unit, first and last hour in that range, and (unless `withDims` is false) the dim keys of the rows at each metric's last hour. */
  listMetrics(sourceId: string, sinceHour: number, withDims?: boolean): Promise<TelemetryMetricInfo[]>
  /** The earliest hour of a metric, or null. */
  firstHour(sourceId: string, metric: string): Promise<number | null>
  /** The earliest hour of each listed metric in one query; metrics without points are absent from the map. */
  firstHours(sourceId: string, metrics: readonly string[]): Promise<Map<string, number>>
  /** Per metric and hour, summed over dims; `[fromHour, toHour)`. */
  hourlyTotals(sourceId: string, metrics: readonly string[], fromHour: number, toHour: number): Promise<TelemetryMetricHourValue[]>
  /** Per hour sum of one metric over the point rows matching `filter` (the hourly rollup has no dims); hours without rows are absent. `[fromHour, toHour)`. */
  filteredHourlyTotals(sourceId: string, metric: string, filter: TelemetryDimFilter, fromHour: number, toHour: number): Promise<TelemetryMetricHourValue[]>
  /** Sum over all groups plus the top groups by total (the group `(other)` is excluded from the ranking). `groupBy` becomes a JSON path: callers must validate it against the dim-key pattern. */
  topGroups(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, limit: number, filter?: TelemetryDimFilter):
    Promise<{ unit: TelemetryUnit | null; total: number; groups: TelemetryGroupTotal[] }>
  /** Only the ranked groups of `topGroups` (one query, no total). `groupBy` becomes a JSON path: callers must validate it against the dim-key pattern. */
  rankGroups(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, limit: number, filter?: TelemetryDimFilter): Promise<TelemetryGroupTotal[]>
  /** `groupBy` becomes a JSON path: callers must validate it against the dim-key pattern. */
  groupHours(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, keys: readonly string[], filter?: TelemetryDimFilter): Promise<TelemetryGroupHours[]>
  /** `groupBy` becomes a JSON path: callers must validate it against the dim-key pattern. */
  groupTotals(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, keys: readonly string[], filter?: TelemetryDimFilter): Promise<TelemetryGroupTotal[]>
  /** Rows with value > 0, newest hour first. */
  nonZeroRows(sourceId: string, metrics: readonly string[], fromHour: number, toHour: number, limit: number): Promise<TelemetryDimRow[]>
  /** The largest dimensioned rows (at most `limit` each) for every (metric, hour) pair, in one query. Row order is unspecified between pairs; within a pair it is by value descending. */
  hoursContributors(sourceId: string, pairs: ReadonlyArray<readonly [string, number]>, limit: number): Promise<TelemetryHourContribution[]>
  /** Deletes points (and rollup rows) past retention and those whose source is gone, at most 20 DELETE statements per call (the rest waits for the next call). Returns the rows deleted for retention (`expired`) and for vanished sources (`orphans`) separately. `orphans: false` skips the orphan lookup and purge (default true). */
  deleteExpired(nowMs: number, options?: { orphans?: boolean }): Promise<{ expired: number; orphans: number }>
}

/** Canonical dims text: JSON of the entries sorted by key; `""` when there are none. */
export function canonicalDims(dims: Record<string, string>): string {
  const keys = Object.keys(dims).sort()
  if (keys.length === 0) return ""
  const sorted: Record<string, string> = {}
  for (const key of keys) sorted[key] = dims[key]!
  return JSON.stringify(sorted)
}
