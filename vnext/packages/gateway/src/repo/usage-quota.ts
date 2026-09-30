import { BILLING_DIMENSIONS, type BillingDimension } from "@vibe-llm/protocols/common"
import type { SqlExecutor } from "./shared/executor.ts"
import type { UsageQuotaProjection, UsageQuotaQuery } from "./types.ts"

type QuotaRow = Record<BillingDimension, number> & Record<`absolute_${BillingDimension}`, number> & {
  requests: number
  costUsd: number
  dimensionRows: number
  absoluteCostUsd: number
}

// Only compile-time billing dimensions are interpolated; scope values are binds.
const dimensions = BILLING_DIMENSIONS.map(d => `'${d}'`).join(",")
const tokenSums = BILLING_DIMENSIONS.flatMap(d => [
  `COALESCE(SUM(CASE WHEN dimension='${d}' THEN 1.0*tokens ELSE 0 END),0) AS ${d}`,
  `COALESCE(SUM(CASE WHEN dimension='${d}' THEN ABS(1.0*tokens) ELSE 0 END),0) AS absolute_${d}`,
]).join(",\n")
const zeroTokens = BILLING_DIMENSIONS.flatMap(d => [`0 AS ${d}`, `0 AS absolute_${d}`]).join(",")

export async function queryUsageQuota(x: SqlExecutor, q: UsageQuotaQuery): Promise<UsageQuotaProjection> {
  const metrics = q.metrics ?? { requests: true, tokens: true, cost: true }
  const readDimensions = metrics.tokens || metrics.cost
  // Historical NULL snapshots use the same fallback as recordCostUsd. Resolve
  // before aggregation, preserving every bucket identity field and known zero.
  // The correlated lookup runs only for a NULL-priced fallback dimension.
  const price = metrics.cost ? `,COALESCE(u.unit_price,CASE
      WHEN u.dimension IN ('input_cache_read','input_cache_write','input_image','output_image') THEN (
        SELECT p.unit_price FROM usage p WHERE p.key_id=u.key_id
        AND p.incoming_model=u.incoming_model AND p.model=u.model
        AND COALESCE(p.upstream,'')=COALESCE(u.upstream,'') AND p.model_key=u.model_key
        AND p.client=u.client AND p.hour=u.hour AND p.dimension=CASE
          WHEN u.dimension='output_image' THEN 'output' ELSE 'input' END
      ) END) AS price` : ""
  const source = readDimensions ? `WITH resolved AS (
    SELECT u.dimension,u.tokens${price}
    FROM usage u WHERE u.key_id=? AND u.hour>=? AND u.hour<? AND u.dimension IN (${dimensions})
  )` : ""
  const requests = metrics.requests
    ? "(SELECT COALESCE(SUM(1.0*requests),0) FROM usage_requests WHERE key_id=? AND hour>=? AND hour<?)"
    : "0"
  const row = await x.first<QuotaRow>(`${source} SELECT
    ${requests} AS requests,
    ${metrics.tokens ? tokenSums : zeroTokens},
    ${metrics.cost ? "COALESCE(SUM(tokens*price/1000000.0),0)" : "0"} AS costUsd,
    ${readDimensions ? "COUNT(*)" : "0"} AS dimensionRows,
    ${metrics.cost ? "COALESCE(SUM(ABS(tokens*price/1000000.0)),0)" : "0"} AS absoluteCostUsd
    ${readDimensions ? "FROM resolved" : ""}`,
  [...(readDimensions ? [q.keyId, q.start, q.end] : []), ...(metrics.requests ? [q.keyId, q.start, q.end] : [])])

  return {
    requests: row?.requests ?? 0,
    tokens: {
      input: row?.input ?? 0, input_cache_read: row?.input_cache_read ?? 0,
      input_cache_write: row?.input_cache_write ?? 0, input_image: row?.input_image ?? 0,
      output: row?.output ?? 0, output_image: row?.output_image ?? 0,
    },
    costUsd: row?.costUsd ?? 0,
    roundoff: {
      dimensionRows: row?.dimensionRows ?? 0,
      absoluteTokens: {
        input: row?.absolute_input ?? 0, input_cache_read: row?.absolute_input_cache_read ?? 0,
        input_cache_write: row?.absolute_input_cache_write ?? 0, input_image: row?.absolute_input_image ?? 0,
        output: row?.absolute_output ?? 0, output_image: row?.absolute_output_image ?? 0,
      },
      absoluteCostUsd: row?.absoluteCostUsd ?? 0,
    },
  }
}
