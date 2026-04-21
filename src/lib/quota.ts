import { getRepo } from "~/repo"

/**
 * Compute weighted token cost using the quota formula:
 *   Cache Read × 10% + Uncached Input × 100% + Output × 500%
 */
export function computeWeightedTokens(
  cacheReadTokens: number,
  inputTokens: number,
  outputTokens: number,
): number {
  return cacheReadTokens * 0.1 + inputTokens * 1.0 + outputTokens * 5.0
}

export interface QuotaResult {
  allowed: boolean
  reason?: string
}

/**
 * Check if an API key has exceeded its daily quota.
 * Returns { allowed: true } if no quota is set or usage is within limits.
 */
export async function checkQuota(apiKeyId: string): Promise<QuotaResult> {
  const repo = getRepo()
  const key = await repo.apiKeys.getById(apiKeyId)
  if (!key) return { allowed: true }

  const hasReqQuota = key.quotaRequestsPerDay != null
  const hasTokenQuota = key.quotaTokensPerDay != null
  if (!hasReqQuota && !hasTokenQuota) return { allowed: true }

  // Query today's usage (UTC day boundaries).
  // IMPORTANT: The usage table is partitioned by UTC hour (the `hour` column is
  // an ISO-8601 string like "2024-01-15T08"). Both this quota check and the
  // dashboard's computeTimeRange must use UTC midnight as the day boundary so
  // that the numbers agree. Never use local-timezone midnight here.
  const now = new Date()
  const todayStart = now.toISOString().slice(0, 10) + "T00"
  const tomorrowStart = new Date(now.getTime() + 86400000).toISOString().slice(0, 10) + "T00"

  const records = await repo.usage.query({ keyId: apiKeyId, start: todayStart, end: tomorrowStart })

  let totalRequests = 0
  let totalWeightedTokens = 0
  for (const r of records) {
    totalRequests += r.requests
    totalWeightedTokens += computeWeightedTokens(r.cacheReadTokens, r.inputTokens, r.outputTokens)
  }

  if (hasReqQuota && totalRequests >= key.quotaRequestsPerDay!) {
    return { allowed: false, reason: `Daily request quota exceeded (${totalRequests}/${key.quotaRequestsPerDay})` }
  }
  if (hasTokenQuota && totalWeightedTokens >= key.quotaTokensPerDay!) {
    return { allowed: false, reason: `Daily token quota exceeded (${Math.round(totalWeightedTokens)}/${key.quotaTokensPerDay})` }
  }

  return { allowed: true }
}
