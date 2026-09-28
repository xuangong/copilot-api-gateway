import { computeWeightedTokens } from "@vibe-llm/protocols/quota"
import type { ApiKeyDetail } from "../api/keys"
import type { UsageOverviewMetrics } from "../api/usage"

export interface QuotaUsage {
  reqLimit: number | null
  reqUsed: number
  reqPercent: number
  tokenLimit: number | null
  tokenUsed: number
  tokenPercent: number
  costLimit: number | null
  costUsed: number
  costPercent: number
  unpricedTokens: number
  unpricedDimensionRows: number
}

export interface QuotaLoad {
  keyId: string | null
  requestId: number
  status: "idle" | "loading" | "ready" | "error"
  total: UsageOverviewMetrics | null
  error: string | null
}

export const IDLE_QUOTA: QuotaLoad = {
  keyId: null, requestId: 0, status: "idle", total: null, error: null,
}

export function beginQuotaLoad(previous: QuotaLoad, keyId: string, requestId: number): QuotaLoad {
  return {
    keyId, requestId, status: "loading",
    total: previous.keyId === keyId ? previous.total : null,
    error: null,
  }
}

export function finishQuotaLoad(previous: QuotaLoad, keyId: string, requestId: number, total: UsageOverviewMetrics): QuotaLoad {
  if (previous.keyId !== keyId || previous.requestId !== requestId) return previous
  return { keyId, requestId, status: "ready", total, error: null }
}

export function failQuotaLoad(previous: QuotaLoad, keyId: string, requestId: number, error: string): QuotaLoad {
  if (previous.keyId !== keyId || previous.requestId !== requestId) return previous
  return { ...previous, status: "error", error }
}

export function projectQuotaUsage(key: Pick<ApiKeyDetail, "quota_requests_per_month" | "quota_tokens_per_month" | "quota_cost_per_month">, total: UsageOverviewMetrics): QuotaUsage {
  const reqLimit = key.quota_requests_per_month ?? null
  const tokenLimit = key.quota_tokens_per_month ?? null
  const costLimit = key.quota_cost_per_month ?? null
  const reqUsed = total.requests
  const tokenUsed = computeWeightedTokens(total.cacheRead, total.cacheCreation, total.input, total.output)
  const costUsed = total.costUSD
  return {
    reqLimit, reqUsed, reqPercent: reqLimit ? Math.round((reqUsed / reqLimit) * 100) : 0,
    tokenLimit, tokenUsed, tokenPercent: tokenLimit ? Math.round((tokenUsed / tokenLimit) * 100) : 0,
    costLimit, costUsed, costPercent: costLimit ? Math.round((costUsed / costLimit) * 100) : 0,
    unpricedTokens: total.unpricedTokens,
    unpricedDimensionRows: total.unpricedDimensionRows,
  }
}
