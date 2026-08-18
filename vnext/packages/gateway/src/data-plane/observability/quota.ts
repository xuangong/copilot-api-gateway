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
import { getRepo } from '../../repo/index.ts'
import { computeWeightedTokens } from './quota-math.ts'
import type { ApiKeyId } from '../../repo/branded-ids.ts'

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

export async function checkQuota(apiKeyId: ApiKeyId): Promise<QuotaResult> {
  const repo = getRepo()
  const key = await repo.apiKeys.getById(apiKeyId)
  if (!key) return { allowed: true }

  const hasReqQuota = key.quotaRequestsPerMonth != null
  const hasTokenQuota = key.quotaTokensPerMonth != null
  if (!hasReqQuota && !hasTokenQuota) return { allowed: true }

  const now = new Date()
  const monthStart = utcMonthStartHour(now, 0)
  const nextMonthStart = utcMonthStartHour(now, 1)

  const records = await repo.usage.query({ keyId: apiKeyId, start: monthStart, end: nextMonthStart })

  let totalRequests = 0
  let totalWeightedTokens = 0
  for (const r of records) {
    totalRequests += r.requests
    const cacheRead = r.tokens.input_cache_read ?? 0
    const input = (r.tokens.input ?? 0) + (r.tokens.input_image ?? 0)
    const output = (r.tokens.output ?? 0) + (r.tokens.output_image ?? 0)
    totalWeightedTokens += computeWeightedTokens(cacheRead, input, output)
  }

  const retryAfterSeconds = secondsUntilNextUtcMonth(now)
  if (hasReqQuota && totalRequests >= key.quotaRequestsPerMonth!) {
    return { allowed: false, reason: `Monthly request quota exceeded (${totalRequests}/${key.quotaRequestsPerMonth}). Resets at the start of the next UTC month.`, retryAfterSeconds }
  }
  if (hasTokenQuota && totalWeightedTokens >= key.quotaTokensPerMonth!) {
    return { allowed: false, reason: `Monthly token quota exceeded (${Math.round(totalWeightedTokens)}/${key.quotaTokensPerMonth}). Resets at the start of the next UTC month.`, retryAfterSeconds }
  }

  return { allowed: true }
}
