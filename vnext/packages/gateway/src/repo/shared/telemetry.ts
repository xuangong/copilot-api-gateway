import type { UserId } from "../branded-ids.ts"
import {
  TELEMETRY_DIMS_RETENTION_DAYS, TELEMETRY_INSERT_CHUNK, TELEMETRY_INSERT_CHUNK_BYTES, TELEMETRY_PLAIN_RETENTION_DAYS, TELEMETRY_PURGE_CHUNK,
  TELEMETRY_PURGE_MAX_CHUNKS, TELEMETRY_ROLLUP_RETENTION_DAYS, canonicalDims,
  type TelemetryDimRow, type TelemetryGroupHours, type TelemetryGroupTotal, type TelemetryHourContribution, type TelemetryMetricHourValue,
  type TelemetryMetricInfo, type TelemetryPoint, type TelemetryRepo, type TelemetrySourceRecord, type TelemetryUnit,
} from "../telemetry.ts"
import type { SqlExecutor, SqlStatement } from "./executor.ts"

const SOURCE_COLS = "id, owner_id, name, key_hash, settings_json, created_at, last_push_at"

interface SourceRow {
  id: string
  owner_id: string
  name: string
  key_hash: string
  settings_json: string
  created_at: string
  last_push_at: string | null
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json)
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

function parseDims(json: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parseObject(json))) if (typeof value === "string") out[key] = value
  return out
}

const toSource = (row: SourceRow): TelemetrySourceRecord => ({
  id: row.id, ownerId: row.owner_id as UserId, name: row.name, keyHash: row.key_hash, settings: parseObject(row.settings_json),
  createdAt: row.created_at, lastPushAt: row.last_push_at,
})

const DELETE_HOURS_SQL = `DELETE FROM telemetry_points WHERE source_id = ? AND metric = ?
  AND hour IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM telemetry_sources WHERE id = ?)`

const INSERT_ROWS_SQL = `INSERT INTO telemetry_points (source_id, metric, hour, dims_key, dims_json, value, unit)
  SELECT ?, json_extract(j.value, '$.m'), json_extract(j.value, '$.h'),
         CASE json_extract(j.value, '$.d') WHEN '{}' THEN '' ELSE json_extract(j.value, '$.d') END,
         json_extract(j.value, '$.d'), json_extract(j.value, '$.v'), json_extract(j.value, '$.u')
  FROM json_each(?) AS j WHERE EXISTS (SELECT 1 FROM telemetry_sources WHERE id = ?)`

const INSERT_ROLLUP_SQL = `INSERT OR REPLACE INTO telemetry_hourly (source_id, metric, hour, unit, value)
  SELECT ?, json_extract(j.value, '$.m'), json_extract(j.value, '$.h'), json_extract(j.value, '$.u'), json_extract(j.value, '$.v')
  FROM json_each(?) AS j WHERE EXISTS (SELECT 1 FROM telemetry_sources WHERE id = ?)`

/** Distinct metrics of a source by seeking from one to the next (a loose index scan over the rollup primary key), each with its first and last hour at or after `since` and the unit of its last hour. */
export const TELEMETRY_METRICS_SQL = `WITH RECURSIVE m(metric) AS (
  SELECT MIN(metric) FROM telemetry_hourly WHERE source_id = ?
  UNION ALL
  SELECT (SELECT MIN(metric) FROM telemetry_hourly WHERE source_id = ? AND metric > m.metric) FROM m WHERE m.metric IS NOT NULL
), r AS (
  SELECT metric,
         (SELECT MIN(hour) FROM telemetry_hourly t WHERE t.source_id = ? AND t.metric = m.metric AND t.hour >= ?) AS first_hour,
         (SELECT MAX(hour) FROM telemetry_hourly t WHERE t.source_id = ? AND t.metric = m.metric) AS last_hour
  FROM m WHERE metric IS NOT NULL
)
SELECT metric, first_hour, last_hour,
       (SELECT unit FROM telemetry_hourly t WHERE t.source_id = ? AND t.metric = r.metric AND t.hour = r.last_hour) AS unit
FROM r WHERE last_hour >= ? ORDER BY metric`

/** Rollup totals per (metric, hour), one row each; a seek per listed metric on the rollup primary key. */
export const TELEMETRY_TOTALS_SQL = `SELECT metric, hour, value, unit FROM telemetry_hourly
  WHERE source_id = ? AND metric IN (SELECT value FROM json_each(?)) AND hour >= ? AND hour < ? ORDER BY metric, hour`

/** Dimension keys of the rows at each listed (metric, hour): a primary key seek per pair. */
export const TELEMETRY_DIM_KEYS_SQL = `SELECT DISTINCT p.metric AS metric, k.key AS dim_key
  FROM json_each(?) AS j CROSS JOIN telemetry_points p, json_each(p.dims_json) AS k
  WHERE p.source_id = ? AND p.metric = json_extract(j.value, '$[0]') AND p.hour = json_extract(j.value, '$[1]') AND p.dims_key <> ''`

/** The group a row belongs to: the value of one dim, or '' when the row lacks that dim. */
const GROUPED = `SELECT COALESCE(json_extract(dims_json, ?), '') AS grp, hour, value FROM telemetry_points
  WHERE source_id = ? AND metric = ? AND hour >= ? AND hour < ?`

/** Source ids present in `telemetry_points` or `telemetry_hourly` but not in `telemetry_sources`, found by seeking from one distinct `source_id` to the next in each table. */
export const TELEMETRY_ORPHAN_SOURCES_SQL = `WITH RECURSIVE s(id) AS (
  SELECT MIN(source_id) FROM telemetry_points
  UNION ALL
  SELECT (SELECT MIN(source_id) FROM telemetry_points WHERE source_id > s.id) FROM s WHERE s.id IS NOT NULL
), h(id) AS (
  SELECT MIN(source_id) FROM telemetry_hourly
  UNION ALL
  SELECT (SELECT MIN(source_id) FROM telemetry_hourly WHERE source_id > h.id) FROM h WHERE h.id IS NOT NULL
)
SELECT id FROM s WHERE id IS NOT NULL AND id NOT IN (SELECT id FROM telemetry_sources)
UNION
SELECT id FROM h WHERE id IS NOT NULL AND id NOT IN (SELECT id FROM telemetry_sources)
LIMIT 50`

export class SharedTelemetryRepo implements TelemetryRepo {
  constructor(private readonly x: SqlExecutor) {}

  async listSources(ownerId: UserId): Promise<TelemetrySourceRecord[]> {
    const rows = await this.x.all<SourceRow>(`SELECT ${SOURCE_COLS} FROM telemetry_sources WHERE owner_id = ? ORDER BY created_at ASC, id ASC`, [ownerId])
    return rows.map(toSource)
  }

  async getSource(id: string): Promise<TelemetrySourceRecord | null> {
    const row = await this.x.first<SourceRow>(`SELECT ${SOURCE_COLS} FROM telemetry_sources WHERE id = ?`, [id])
    return row ? toSource(row) : null
  }

  async findSourceByKeyHash(keyHash: string): Promise<TelemetrySourceRecord | null> {
    const row = await this.x.first<SourceRow>(`SELECT ${SOURCE_COLS} FROM telemetry_sources WHERE key_hash = ?`, [keyHash])
    return row ? toSource(row) : null
  }

  async createSourceWithinLimit(source: TelemetrySourceRecord, limit: number): Promise<boolean> {
    const result = await this.x.run(
      `INSERT INTO telemetry_sources (${SOURCE_COLS}) SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM telemetry_sources WHERE owner_id = ?) < ?`,
      [source.id, source.ownerId, source.name, source.keyHash, JSON.stringify(source.settings), source.createdAt, source.lastPushAt, source.ownerId, limit],
    )
    return result.changes > 0
  }

  async updateSource(id: string, ownerId: UserId, patch: { name?: string; settings?: Record<string, unknown> }): Promise<TelemetrySourceRecord | null> {
    const row = await this.x.first<SourceRow>(
      `UPDATE telemetry_sources SET name = COALESCE(?, name), settings_json = COALESCE(?, settings_json)
       WHERE id = ? AND owner_id = ? RETURNING ${SOURCE_COLS}`,
      [patch.name ?? null, patch.settings === undefined ? null : JSON.stringify(patch.settings), id, ownerId],
    )
    return row ? toSource(row) : null
  }

  async rotateKey(id: string, ownerId: UserId, keyHash: string): Promise<TelemetrySourceRecord | null> {
    const row = await this.x.first<SourceRow>(
      `UPDATE telemetry_sources SET key_hash = ? WHERE id = ? AND owner_id = ? RETURNING ${SOURCE_COLS}`, [keyHash, id, ownerId])
    return row ? toSource(row) : null
  }

  async deleteSource(id: string, ownerId: UserId): Promise<boolean> {
    const result = await this.x.run("DELETE FROM telemetry_sources WHERE id = ? AND owner_id = ?", [id, ownerId])
    // The points stay behind as orphans; scheduled retention purges them gradually so one request never needs many deletes.
    return result.changes > 0
  }

  async deleteSourcesByOwner(ownerId: UserId): Promise<void> {
    await this.x.run("DELETE FROM telemetry_sources WHERE owner_id = ?", [ownerId])
  }

  async replaceHours(sourceId: string, points: readonly TelemetryPoint[], nowIso: string): Promise<boolean> {
    if (!this.x.batch) throw new Error("SqlExecutor.batch is required for telemetry")
    const hoursByMetric = new Map<string, Set<number>>()
    for (const point of points) {
      const hours = hoursByMetric.get(point.metric) ?? new Set<number>()
      hours.add(point.hour)
      hoursByMetric.set(point.metric, hours)
    }
    const statements: SqlStatement[] = []
    for (const [metric, hours] of hoursByMetric) {
      statements.push({ sql: DELETE_HOURS_SQL, binds: [sourceId, metric, JSON.stringify([...hours]), sourceId] })
    }
    // A chunk ends at TELEMETRY_INSERT_CHUNK rows or TELEMETRY_INSERT_CHUNK_BYTES of serialized JSON, whichever comes first:
    // dims text is escaped twice (canonical dims, then the rows array), and D1 caps one bound value at 2 000 000 bytes.
    const encoder = new TextEncoder()
    let rows: string[] = []
    let bytes = 2
    const flush = () => {
      if (rows.length === 0) return
      statements.push({ sql: INSERT_ROWS_SQL, binds: [sourceId, `[${rows.join(",")}]`, sourceId] })
      rows = []
      bytes = 2
    }
    for (const point of points) {
      const key = canonicalDims(point.dims)
      // dims_key is derived in SQL from `d` ('{}' means none), so the dims text travels once per row.
      const row = JSON.stringify({ m: point.metric, h: point.hour, d: key === "" ? "{}" : key, v: point.value, u: point.unit })
      const rowBytes = encoder.encode(row).length + 1
      if (rows.length >= TELEMETRY_INSERT_CHUNK || (rows.length > 0 && bytes + rowBytes > TELEMETRY_INSERT_CHUNK_BYTES)) flush()
      rows.push(row)
      bytes += rowBytes
    }
    flush()
    // The rollup row of every (metric, hour) in the body is replaced with the sum of the pushed points, in the same batch.
    // Rows are at most 20 metrics x 168 hours = 3 360, so at most 4 statements.
    const rollup = new Map<string, { m: string; h: number; u: TelemetryUnit; v: number }>()
    for (const point of points) {
      const key = `${point.metric}\u0000${point.hour}`
      const entry = rollup.get(key)
      if (entry) entry.v += point.value
      else rollup.set(key, { m: point.metric, h: point.hour, u: point.unit, v: point.value })
    }
    const rollupRows = [...rollup.values()]
    for (let i = 0; i < rollupRows.length; i += TELEMETRY_INSERT_CHUNK) {
      statements.push({ sql: INSERT_ROLLUP_SQL, binds: [sourceId, JSON.stringify(rollupRows.slice(i, i + TELEMETRY_INSERT_CHUNK)), sourceId] })
    }
    statements.push({ sql: "UPDATE telemetry_sources SET last_push_at = ? WHERE id = ?", binds: [nowIso, sourceId] })
    const results = await this.x.batch(statements)
    return (results[results.length - 1]?.changes ?? 0) > 0
  }

  async listMetrics(sourceId: string, sinceHour: number, withDims = true): Promise<TelemetryMetricInfo[]> {
    const metrics = await this.x.all<{ metric: string; unit: TelemetryUnit; first_hour: number; last_hour: number }>(
      TELEMETRY_METRICS_SQL, [sourceId, sourceId, sourceId, sinceHour, sourceId, sourceId, sinceHour])
    const byMetric = new Map<string, string[]>()
    if (withDims && metrics.length > 0) {
      const pairs = metrics.map(row => [row.metric, Number(row.last_hour)])
      const keys = await this.x.all<{ metric: string; dim_key: string }>(TELEMETRY_DIM_KEYS_SQL, [JSON.stringify(pairs), sourceId])
      for (const row of keys) byMetric.set(row.metric, [...(byMetric.get(row.metric) ?? []), row.dim_key])
    }
    return metrics.map(row => ({
      metric: row.metric, unit: row.unit, firstHour: Number(row.first_hour), lastHour: Number(row.last_hour),
      dimKeys: (byMetric.get(row.metric) ?? []).sort(),
    }))
  }

  async firstHour(sourceId: string, metric: string): Promise<number | null> {
    const row = await this.x.first<{ first_hour: number | null }>(
      "SELECT MIN(hour) AS first_hour FROM telemetry_hourly WHERE source_id = ? AND metric = ?", [sourceId, metric])
    return row?.first_hour === null || row?.first_hour === undefined ? null : Number(row.first_hour)
  }

  async firstHours(sourceId: string, metrics: readonly string[]): Promise<Map<string, number>> {
    if (metrics.length === 0) return new Map()
    const rows = await this.x.all<{ metric: string; first_hour: number | null }>(
      `SELECT j.value AS metric, (SELECT MIN(hour) FROM telemetry_hourly WHERE source_id = ? AND metric = j.value) AS first_hour
       FROM json_each(?) AS j`, [sourceId, JSON.stringify(metrics)])
    return new Map(rows.flatMap(row => row.first_hour === null ? [] : [[row.metric, Number(row.first_hour)] as const]))
  }

  async hourlyTotals(sourceId: string, metrics: readonly string[], fromHour: number, toHour: number): Promise<TelemetryMetricHourValue[]> {
    if (metrics.length === 0) return []
    const rows = await this.x.all<{ metric: string; hour: number; value: number; unit: TelemetryUnit }>(
      TELEMETRY_TOTALS_SQL, [sourceId, JSON.stringify(metrics), fromHour, toHour])
    return rows.map(row => ({ metric: row.metric, hour: Number(row.hour), value: Number(row.value), unit: row.unit }))
  }

  async rankGroups(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, limit: number): Promise<TelemetryGroupTotal[]> {
    const groups = await this.x.all<{ grp: string; total: number }>(
      `SELECT grp, SUM(value) AS total FROM (${GROUPED}) WHERE grp <> '(other)' GROUP BY grp ORDER BY total DESC, grp ASC LIMIT ?`,
      [`$.${groupBy}`, sourceId, metric, fromHour, toHour, limit])
    return groups.map((row): TelemetryGroupTotal => ({ key: row.grp, value: Number(row.total) }))
  }

  /** The total is summed over the same point rows as the groups (not the rollup), so hours whose dimension rows retention already purged cannot inflate `(other)`. */
  async topGroups(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, limit: number) {
    const total = await this.x.first<{ total: number; unit: TelemetryUnit | null }>(
      `SELECT COALESCE(SUM(value), 0) AS total, MAX(unit) AS unit FROM telemetry_points
       WHERE source_id = ? AND metric = ? AND hour >= ? AND hour < ?`, [sourceId, metric, fromHour, toHour])
    return { unit: total?.unit ?? null, total: Number(total?.total ?? 0), groups: await this.rankGroups(sourceId, metric, groupBy, fromHour, toHour, limit) }
  }

  async groupHours(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, keys: readonly string[]): Promise<TelemetryGroupHours[]> {
    if (keys.length === 0) return []
    const rows = await this.x.all<{ grp: string; hour: number; value: number }>(
      `SELECT grp, hour, SUM(value) AS value FROM (${GROUPED}) WHERE grp IN (SELECT value FROM json_each(?))
       GROUP BY grp, hour ORDER BY grp, hour`, [`$.${groupBy}`, sourceId, metric, fromHour, toHour, JSON.stringify(keys)])
    const byKey = new Map<string, TelemetryGroupHours>()
    for (const row of rows) {
      const entry = byKey.get(row.grp) ?? { key: row.grp, points: [] }
      entry.points.push({ hour: Number(row.hour), value: Number(row.value) })
      byKey.set(row.grp, entry)
    }
    return keys.flatMap(key => { const entry = byKey.get(key); return entry ? [entry] : [] })
  }

  async groupTotals(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, keys: readonly string[]): Promise<TelemetryGroupTotal[]> {
    if (keys.length === 0) return []
    const rows = await this.x.all<{ grp: string; total: number }>(
      `SELECT grp, SUM(value) AS total FROM (${GROUPED}) WHERE grp IN (SELECT value FROM json_each(?)) GROUP BY grp`,
      [`$.${groupBy}`, sourceId, metric, fromHour, toHour, JSON.stringify(keys)])
    return rows.map(row => ({ key: row.grp, value: Number(row.total) }))
  }

  async nonZeroRows(sourceId: string, metrics: readonly string[], fromHour: number, toHour: number, limit: number): Promise<TelemetryDimRow[]> {
    if (metrics.length === 0) return []
    const rows = await this.x.all<{ metric: string; hour: number; dims_json: string; value: number }>(
      `SELECT metric, hour, dims_json, value FROM telemetry_points
       WHERE source_id = ? AND metric IN (SELECT value FROM json_each(?)) AND hour >= ? AND hour < ? AND value > 0
       ORDER BY hour DESC, metric ASC, value DESC, dims_key ASC LIMIT ?`, [sourceId, JSON.stringify(metrics), fromHour, toHour, limit])
    return rows.map(row => ({ metric: row.metric, hour: Number(row.hour), dims: parseDims(row.dims_json), value: Number(row.value) }))
  }

  async hoursContributors(sourceId: string, pairs: ReadonlyArray<readonly [string, number]>, limit: number): Promise<TelemetryHourContribution[]> {
    if (pairs.length === 0) return []
    const rows = await this.x.all<{ metric: string; hour: number; dims_json: string; value: number }>(
      `SELECT metric, hour, dims_json, value FROM (
         SELECT p.metric AS metric, p.hour AS hour, p.dims_json AS dims_json, p.value AS value,
                ROW_NUMBER() OVER (PARTITION BY p.metric, p.hour ORDER BY p.value DESC, p.dims_key ASC) AS rn
         FROM json_each(?) AS j CROSS JOIN telemetry_points p
         WHERE p.source_id = ? AND p.metric = json_extract(j.value, '$[0]') AND p.hour = json_extract(j.value, '$[1]') AND p.dims_key <> ''
       ) WHERE rn <= ? ORDER BY metric ASC, hour ASC, rn ASC`, [JSON.stringify(pairs), sourceId, limit])
    return rows.map(row => ({ metric: row.metric, hour: Number(row.hour), dims: parseDims(row.dims_json), value: Number(row.value) }))
  }

  async deleteExpired(nowMs: number, options: { orphans?: boolean } = {}): Promise<{ expired: number; orphans: number }> {
    const nowSec = Math.floor(nowMs / 1000)
    const withDims = nowSec - TELEMETRY_DIMS_RETENTION_DAYS * 86_400
    const plain = nowSec - TELEMETRY_PLAIN_RETENTION_DAYS * 86_400
    const rollup = nowSec - TELEMETRY_ROLLUP_RETENTION_DAYS * 86_400
    // One statement budget for the whole call keeps a sweep within the per-invocation query limit; the rest is left for the next sweep.
    // Each class has its own predicate, so each walks its own partial index (or the rollup hour index) and nothing else.
    const budget = { left: TELEMETRY_PURGE_MAX_CHUNKS }
    let expired = await this.purge(POINTS, "dims_key <> '' AND hour < ?", [withDims], budget, 5)
    expired += await this.purge(POINTS, "dims_key = '' AND hour < ?", [plain], budget, 3)
    expired += await this.purge(ROLLUP, "hour < ?", [rollup], budget, 2)
    let orphans = 0
    if (budget.left > 0 && options.orphans !== false) {
      // Orphan ids come from a loose index scan over each primary key (one seek per distinct source), so a sweep without orphans never scans a table.
      const ids = await this.x.all<{ id: string }>(TELEMETRY_ORPHAN_SOURCES_SQL, [])
      for (const { id } of ids) {
        if (budget.left <= 0) break
        orphans += await this.purge(POINTS, "source_id = ?", [id], budget, budget.left)
        if (budget.left > 0) orphans += await this.purge(ROLLUP, "source_id = ?", [id], budget, budget.left)
      }
    }
    return { expired, orphans }
  }

  /** Deletes matching rows in chunks, spending at most `cap` statements from the shared budget. Row-value IN keeps each statement on the primary key. */
  private async purge(table: { name: string; key: string }, where: string, binds: unknown[], budget: { left: number }, cap: number): Promise<number> {
    let total = 0
    for (let used = 0; used < cap && budget.left > 0; used++) {
      budget.left--
      const result = await this.x.run(
        `DELETE FROM ${table.name} WHERE (${table.key}) IN
           (SELECT ${table.key} FROM ${table.name} WHERE ${where} LIMIT ${TELEMETRY_PURGE_CHUNK})`, binds)
      total += result.changes
      if (result.changes < TELEMETRY_PURGE_CHUNK) break
    }
    return total
  }
}

const POINTS = { name: "telemetry_points", key: "source_id, metric, hour, dims_key" }
const ROLLUP = { name: "telemetry_hourly", key: "source_id, metric, hour" }
