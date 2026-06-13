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

// vNext server returns the per-dimension shape from aggregateUsageForDisplay:
//   { tokens: { input?, output?, input_cache_read?, input_cache_write?, ... }, cost: number, ... }
// The dashboard was originally written against the main repo's flat shape, so
// we adapt at the API boundary instead of touching every reducer.
interface ServerUsageRow {
  hour: string
  keyId: string
  keyName?: string
  ownerId?: string
  ownerName?: string
  model?: string
  client?: string
  requests?: number
  tokens?: {
    input?: number
    output?: number
    input_cache_read?: number
    input_cache_write?: number
    input_image?: number
    output_image?: number
  }
  cost?: number | { totalUSD?: number } | null
}

function adaptRow(r: ServerUsageRow): UsageRow {
  const t = r.tokens ?? {}
  const input = (t.input ?? 0) + (t.input_image ?? 0)
  const output = (t.output ?? 0) + (t.output_image ?? 0)
  const cacheRead = t.input_cache_read ?? 0
  const cacheCreation = t.input_cache_write ?? 0
  let cost: { totalUSD?: number } | null = null
  if (typeof r.cost === "number") cost = { totalUSD: r.cost }
  else if (r.cost && typeof r.cost === "object") cost = r.cost
  return {
    hour: r.hour,
    keyId: r.keyId,
    keyName: r.keyName,
    ownerId: r.ownerId,
    ownerName: r.ownerName,
    model: r.model,
    client: r.client,
    requests: r.requests ?? 0,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    cost,
  }
}

export interface UsageRangeQuery {
  start: string // "YYYY-MM-DDTHH"
  end: string // "YYYY-MM-DDTHH"
}

export async function fetchTokenUsage(range: UsageRangeQuery): Promise<UsageRow[]> {
  const rows = await api<ServerUsageRow[]>("/api/token-usage", { query: { start: range.start, end: range.end } })
  return rows.map(adaptRow)
}
