/**
 * Daily quota gate. UTC day boundaries. Returns Retry-After seconds on deny so
 * SDKs honoring it sleep until quota resets instead of generic backoff.
 *
 * `getById(unknownId)` resolves to null → allowed: true. That covers the dev
 * auth path (`apiKeyId === 'dev-user'`, no row in `api_keys`).
 */
import { getRepo } from '../repo/index.ts'
import { computeWeightedTokens } from './quota-math.ts'

export { computeWeightedTokens }

export interface QuotaResult {
  allowed: boolean
  reason?: string
  retryAfterSeconds?: number
}

function secondsUntilNextUtcDay(now: Date): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0))
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000))
}

export async function checkQuota(apiKeyId: string): Promise<QuotaResult> {
  const repo = getRepo()
  const key = await repo.apiKeys.getById(apiKeyId)
  if (!key) return { allowed: true }

  const hasReqQuota = key.quotaRequestsPerDay != null
  const hasTokenQuota = key.quotaTokensPerDay != null
  if (!hasReqQuota && !hasTokenQuota) return { allowed: true }

  const now = new Date()
  const todayStart = now.toISOString().slice(0, 10) + 'T00'
  const tomorrowStart = new Date(now.getTime() + 86400000).toISOString().slice(0, 10) + 'T00'

  const records = await repo.usage.query({ keyId: apiKeyId, start: todayStart, end: tomorrowStart })

  let totalRequests = 0
  let totalWeightedTokens = 0
  for (const r of records) {
    totalRequests += r.requests
    totalWeightedTokens += computeWeightedTokens(r.cacheReadTokens, r.inputTokens, r.outputTokens)
  }

  const retryAfterSeconds = secondsUntilNextUtcDay(now)
  if (hasReqQuota && totalRequests >= key.quotaRequestsPerDay!) {
    return { allowed: false, reason: `Daily request quota exceeded (${totalRequests}/${key.quotaRequestsPerDay}). Resets at next UTC midnight.`, retryAfterSeconds }
  }
  if (hasTokenQuota && totalWeightedTokens >= key.quotaTokensPerDay!) {
    return { allowed: false, reason: `Daily token quota exceeded (${Math.round(totalWeightedTokens)}/${key.quotaTokensPerDay}). Resets at next UTC midnight.`, retryAfterSeconds }
  }

  return { allowed: true }
}
