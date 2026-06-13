import { api } from "./client"

// Shape returned by GET /api/token-usage. Mirrors src/routes/dashboard.ts
// (UsageRecord + enrichUsage + key/owner name decoration).
export interface UsageRow {
  hour: string // "YYYY-MM-DDTHH" (UTC hour)
  keyId: string
  keyName?: string
  ownerId?: string
  ownerName?: string
  model?: string
  client?: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  cost?: { totalUSD?: number } | null
}

export interface UsageRangeQuery {
  start: string // "YYYY-MM-DDTHH"
  end: string // "YYYY-MM-DDTHH"
}

export function fetchTokenUsage(range: UsageRangeQuery): Promise<UsageRow[]> {
  return api<UsageRow[]>("/api/token-usage", { query: { start: range.start, end: range.end } })
}
