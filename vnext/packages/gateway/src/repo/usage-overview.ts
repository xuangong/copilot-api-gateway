import type { BillingDimension } from "@vibe-llm/protocols/common"
import { BILLING_DIMENSIONS } from "@vibe-llm/protocols/common"
import type { ApiKeyId } from "./branded-ids"
import type { SqlExecutor } from "./shared/executor"

export type UsageOverviewAxis = "key" | "client" | "model" | "incomingModel"
export interface UsageOverviewQuery {
  readonly start: string
  readonly end: string
  readonly bucket: "hour" | "day"
  readonly axis: UsageOverviewAxis
  readonly limit?: number
  /** Offset in raw binary axis order; not a snapshot. New/deleted categories may shift pages. */
  readonly cursor?: string
  readonly keyId?: ApiKeyId
  readonly keyIds?: readonly ApiKeyId[]
  readonly client?: string
  readonly model?: string
  readonly incomingModel?: string | null
}
export interface UsageOverviewMetrics {
  readonly requests: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheCreation: number
  /** Known recorded cost; unresolved prices contribute zero. */
  readonly costUSD: number
  readonly hasRecords: boolean
  readonly unpricedTokens: number
  /** Known-dimension storage rows still unresolved after fallback, including zero quantities. */
  readonly unpricedDimensionRows: number
  readonly observedDimensions: readonly BillingDimension[]
}
export interface UsageOverview {
  readonly range: Readonly<Pick<UsageOverviewQuery, "start" | "end" | "bucket">>
  readonly total: UsageOverviewMetrics
  /** UTC buckets with records; omitted buckets contain no records. */
  readonly buckets: readonly (UsageOverviewMetrics & { readonly bucket: string })[]
  readonly breakdown: {
    readonly axis: UsageOverviewAxis
    readonly rows: readonly (UsageOverviewMetrics & { readonly value: string })[]
    readonly nextCursor: string | null
    readonly hasMore: boolean
  }
}
const axes = { key: "key_id", client: "client", model: "model", incomingModel: "incoming_model" } as const
export function validateUsageOverview(q: UsageOverviewQuery): void {
  const parse = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(s)) throw new Error("Expected UTC hour YYYY-MM-DDTHH")
    const n = Date.parse(`${s}:00:00Z`)
    if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 13) !== s) throw new Error("Invalid UTC hour")
    return n
  }
  const start = parse(q.start), end = parse(q.end)
  if (end <= start) throw new Error("end must be after start")
  if (q.bucket !== "hour" && q.bucket !== "day") throw new Error("Invalid bucket")
  const size = q.bucket === "hour" ? 3600000 : 86400000
  if (Math.ceil(end / size) - Math.floor(start / size) > (q.bucket === "hour" ? 744 : 366)) throw new Error("Too many UTC buckets")
  if (!Object.hasOwn(axes, q.axis)) throw new Error("Invalid axis")
  if (!Number.isInteger(q.limit ?? 100) || (q.limit ?? 100) < 1 || (q.limit ?? 100) > 200) throw new Error("limit must be 1..200")
  if (q.cursor !== undefined && (!/^(0|[1-9]\d*)$/.test(q.cursor) || !Number.isSafeInteger(Number(q.cursor)))) throw new Error("Invalid cursor")
}
interface Row {
  value: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUSD: number
  records: number
  unpricedTokens: number
  unpricedDimensionRows: number
  input_seen: number
  output_seen: number
  input_cache_read_seen: number
  input_cache_write_seen: number
  input_image_seen: number
  output_image_seen: number
}
function metrics(r?: Row): UsageOverviewMetrics {
  return { requests: r?.requests ?? 0, input: r?.input ?? 0, output: r?.output ?? 0,
    cacheRead: r?.cacheRead ?? 0, cacheCreation: r?.cacheCreation ?? 0, costUSD: r?.costUSD ?? 0,
    hasRecords: (r?.records ?? 0) > 0, unpricedTokens: r?.unpricedTokens ?? 0, unpricedDimensionRows: r?.unpricedDimensionRows ?? 0,
    observedDimensions: BILLING_DIMENSIONS.filter(d => r && r[`${d}_seen`] > 0) }
}
export async function queryUsageOverview(x: SqlExecutor, q: UsageOverviewQuery): Promise<UsageOverview> {
  validateUsageOverview(q)
  const binds: unknown[] = [q.start, q.end]
  const conditions = ["hour >= ?", "hour < ?"]
  if (q.keyIds !== undefined) conditions.push("key_id IN (SELECT value FROM scope_keys)")
  for (const [column, value] of [["key_id", q.keyId], ["client", q.client], ["model", q.model], ["incoming_model", q.incomingModel]] as const) {
    if (value != null) { conditions.push(`${column} = ?`); binds.push(value) }
  }
  const where = conditions.join(" AND ")
  const dimensions = BILLING_DIMENSIONS.map(d => `'${d}'`).join(",")
  // Resolve historical null snapshots before collapsing upstream/model_key.
  const scope = q.keyIds === undefined ? "" : "scope_keys AS (SELECT value FROM json_each(?)),"
  const cte = `WITH ${scope} resolved AS MATERIALIZED (
    SELECT u.*, CASE WHEN dimension IN (${dimensions}) THEN COALESCE(unit_price, CASE WHEN dimension IN ('input_cache_read','input_cache_write','input_image','output_image') THEN (
      SELECT p.unit_price FROM usage p WHERE p.key_id=u.key_id AND p.incoming_model=u.incoming_model
      AND p.model=u.model AND COALESCE(p.upstream,'')=COALESCE(u.upstream,'') AND p.model_key=u.model_key
      AND p.client=u.client AND p.hour=u.hour AND p.dimension=CASE
      WHEN u.dimension IN ('input_cache_read','input_cache_write','input_image') THEN 'input'
      WHEN u.dimension='output_image' THEN 'output' END
    ) END) END AS price FROM usage u WHERE ${where}
  ), dims AS (
    SELECT key_id,incoming_model,model,client,hour,dimension,SUM(MAX(0,tokens)) AS tokens,
      SUM(COALESCE(tokens*price/1000000.0,0)) AS cost,
      SUM(CASE WHEN price IS NULL AND dimension IN (${dimensions}) THEN tokens ELSE 0 END) AS unpriced,
      SUM(CASE WHEN price IS NULL AND dimension IN (${dimensions}) THEN 1 ELSE 0 END) AS unpricedDimensionRows
    FROM resolved GROUP BY key_id,incoming_model,model,client,hour,dimension
  ), entries AS (
    SELECT key_id,incoming_model,model,client,hour,0 AS requests,
      CASE WHEN dimension IN ('input','input_image') THEN tokens ELSE 0 END AS input,
      CASE WHEN dimension IN ('output','output_image') THEN tokens ELSE 0 END AS output,
      CASE WHEN dimension='input_cache_read' THEN tokens ELSE 0 END AS cacheRead,
      CASE WHEN dimension='input_cache_write' THEN tokens ELSE 0 END AS cacheCreation,
      cost AS costUSD,unpriced AS unpricedTokens,unpricedDimensionRows,${BILLING_DIMENSIONS.map(d => `dimension='${d}' AS ${d}_seen`).join(",")}
    FROM dims UNION ALL
    SELECT key_id,incoming_model,model,client,hour,requests,0,0,0,0,0,0,0,0,0,0,0,0,0
    FROM usage_requests WHERE ${where}
  )`
  const sums = ["requests", "input", "output", "cacheRead", "cacheCreation", "costUSD", "unpricedTokens", "unpricedDimensionRows", ...BILLING_DIMENSIONS.map(d => `${d}_seen`)].map(n => `COALESCE(SUM(${n}),0) AS ${n}`).join(",") + ",COUNT(*) AS records"
  const bucket = q.bucket === "hour" ? "hour" : "substr(hour,1,10)"
  const axis = axes[q.axis]
  const limit = q.limit ?? 100, offset = Number(q.cursor ?? 0)
  const args = [...(q.keyIds === undefined ? [] : [JSON.stringify(q.keyIds)]), ...binds, ...binds]
  const [total, buckets, page] = await Promise.all([
    x.all<Row>(`${cte} SELECT '' AS value,${sums} FROM entries`, args),
    x.all<Row>(`${cte} SELECT ${bucket} AS value,${sums} FROM entries GROUP BY ${bucket} ORDER BY value COLLATE BINARY`, args),
    x.all<Row>(`${cte} SELECT ${axis} AS value,${sums} FROM entries GROUP BY ${axis} ORDER BY value COLLATE BINARY LIMIT ? OFFSET ?`, [...args, limit + 1, offset]),
  ])
  const hasMore = page.length > limit
  return { range: { start: q.start, end: q.end, bucket: q.bucket }, total: metrics(total[0]),
    buckets: buckets.map(r => ({ bucket: r.value, ...metrics(r) })),
    breakdown: { axis: q.axis, rows: page.slice(0, limit).map(r => ({ value: r.value, ...metrics(r) })),
      hasMore, nextCursor: hasMore ? String(offset + limit) : null } }
}
