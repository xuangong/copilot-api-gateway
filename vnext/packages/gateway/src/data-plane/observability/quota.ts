/**
 * Monthly quota gate. UTC calendar-month boundaries. Returns Retry-After
 * seconds on deny so SDKs honoring it sleep until quota resets instead of
 * generic backoff.
 *
 * UTC rather than a caller timezone: the gateway cannot know where a key is
 * being used from, and the usage table is already bucketed by UTC hour. The
 * dashboard's usage chart is local-time by design — the two answer different
 * questions and only need to be internally consistent.
 *
 * `getById(unknownId)` resolves to null → allowed: true. That covers the dev
 * auth path (`apiKeyId === 'dev-user'`, no row in `api_keys`).
 */
import { getDataPlaneConfiguration, getRepo } from '../../repo/index.ts'
import { recordCostUsd } from '../../shared/usage-cost.ts'
import { computeWeightedTokens } from './quota-math.ts'
import type { ApiKeyId } from '../../repo/branded-ids.ts'
import type { TokenUsage } from '../../repo/types.ts'

export { computeWeightedTokens }

export interface QuotaResult {
  allowed: boolean
  reason?: string
  retryAfterSeconds?: number
}

function secondsUntilNextUtcMonth(now: Date): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0))
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000))
}

/** "YYYY-MM-01T00" for the UTC month containing `now`, offset by `monthDelta`. */
function utcMonthStartHour(now: Date, monthDelta: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthDelta, 1, 0, 0, 0))
  return d.toISOString().slice(0, 10) + 'T00'
}

function weightedTokens(tokens: TokenUsage): number {
  return computeWeightedTokens(tokens.input_cache_read ?? 0, tokens.input_cache_write ?? 0,
    (tokens.input ?? 0) + (tokens.input_image ?? 0), (tokens.output ?? 0) + (tokens.output_image ?? 0))
}

function needsExactQuotaCheck(total: number, limit: number | undefined, absoluteTotal: number, terms: number): boolean {
  if (limit == null || terms === 0) return false
  // Both paths use at most a small constant number of arithmetic operations
  // per known dimension: products, the six-term bucket sum, division, and
  // accumulation. 16n+64 bounds their combined forward errors, including the
  // aggregate magnitude estimate. EPSILON (twice unit roundoff) gives margin.
  // gamma(k) bounds reassociation error against the sum of absolute terms;
  // the MIN_VALUE allowance covers underflow. Pathological bounds recheck.
  const operations = 16 * terms + 64
  const scaledError = operations * Number.EPSILON
  if (scaledError >= 0.5 || !Number.isFinite(total) || !Number.isFinite(absoluteTotal)) return true
  const error = scaledError / (1 - scaledError) * Math.max(Math.abs(total), absoluteTotal)
    + operations * Number.MIN_VALUE
  return Math.abs(total - limit) <= error
}

export async function checkQuota(apiKeyId: ApiKeyId): Promise<QuotaResult> {
  const repo = getRepo()
  const key = await getDataPlaneConfiguration().apiKeys.getById(apiKeyId)
  if (!key) return { allowed: true }

  const requestLimit = key.quotaRequestsPerMonth
  const tokenLimit = key.quotaTokensPerMonth
  const costLimit = key.quotaCostPerMonth
  if (requestLimit == null && tokenLimit == null && costLimit == null) return { allowed: true }

  const now = new Date()
  const monthStart = utcMonthStartHour(now, 0)
  const nextMonthStart = utcMonthStartHour(now, 1)

  const range = { keyId: apiKeyId, start: monthStart, end: nextMonthStart }
  const totals = await repo.usage.queryQuota({ ...range,
    metrics: { requests: requestLimit != null, tokens: tokenLimit != null, cost: costLimit != null },
  })
  const retryAfterSeconds = secondsUntilNextUtcMonth(now)
  if (requestLimit != null && totals.requests >= requestLimit) {
    return { allowed: false, reason: `Monthly request quota exceeded (${totals.requests}/${key.quotaRequestsPerMonth}). Resets at the start of the next UTC month.`, retryAfterSeconds }
  }
  let totalRequests = totals.requests
  let totalWeightedTokens = weightedTokens(totals.tokens)
  let totalCostUsd = totals.costUsd
  if (needsExactQuotaCheck(totalWeightedTokens, tokenLimit, weightedTokens(totals.roundoff.absoluteTokens), totals.roundoff.dimensionRows)
    || needsExactQuotaCheck(totalCostUsd, costLimit, totals.roundoff.absoluteCostUsd, totals.roundoff.dimensionRows)) {
    // Only rounding-sensitive thresholds retain the legacy ordered JS fold.
    // Ordinary admissions transfer a single row instead of the full month.
    const records = await repo.usage.query(range)
    totalRequests = 0
    totalWeightedTokens = 0
    totalCostUsd = 0
    for (const r of records) {
      totalRequests += r.requests
      totalWeightedTokens += weightedTokens(r.tokens)
      totalCostUsd += recordCostUsd(r)
    }
  }

  if (requestLimit != null && totalRequests >= requestLimit) {
    return { allowed: false, reason: `Monthly request quota exceeded (${totalRequests}/${key.quotaRequestsPerMonth}). Resets at the start of the next UTC month.`, retryAfterSeconds }
  }
  if (tokenLimit != null && totalWeightedTokens >= tokenLimit) {
    return { allowed: false, reason: `Monthly token quota exceeded (${Math.round(totalWeightedTokens)}/${key.quotaTokensPerMonth}). Resets at the start of the next UTC month.`, retryAfterSeconds }
  }
  if (costLimit != null && totalCostUsd >= costLimit) {
    return { allowed: false, reason: `Monthly cost quota exceeded ($${totalCostUsd.toFixed(4)}/$${key.quotaCostPerMonth}). Resets at the start of the next UTC month.`, retryAfterSeconds }
  }

  return { allowed: true }
}
