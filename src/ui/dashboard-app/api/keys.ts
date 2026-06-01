import { api } from "./client"

// Shape returned by GET /api/keys (see src/routes/api-keys.ts keyToJson()).
export interface KeyRefDescriptor {
  id: string
  name: string | null
  owner_id: string | null
  broken?: boolean
}

export interface KeyAssigneeBrief {
  user_id: string
  user_name: string | null
}

export interface ApiKeyDetail {
  id: string
  name: string
  key: string
  created_at: string
  last_used_at: string | null
  owner_id: string | null
  owner_name: string | null
  is_owner: boolean
  quota_requests_per_day: number | null
  quota_tokens_per_day: number | null
  web_search_enabled: boolean
  web_search_langsearch_key: string | null
  web_search_langsearch_ref: KeyRefDescriptor | null
  web_search_tavily_key: string | null
  web_search_tavily_ref: KeyRefDescriptor | null
  web_search_ms_grounding_key: string | null
  web_search_ms_grounding_ref: KeyRefDescriptor | null
  web_search_priority: string[] | null
  assignees?: KeyAssigneeBrief[]
}

export interface KeyPatchBody {
  name?: string
  quota_requests_per_day?: number | null
  quota_tokens_per_day?: number | null
  web_search_enabled?: boolean
  web_search_langsearch_key?: string | null
  web_search_tavily_key?: string | null
  web_search_ms_grounding_key?: string | null
  web_search_priority?: string[] | null
  web_search_langsearch_ref?: string | null
  web_search_tavily_ref?: string | null
  web_search_ms_grounding_ref?: string | null
}

export interface EngineUsage {
  engineId: string
  attempts: number
  successes: number
  failures: number
  emptyResults: number
  totalResults: number
  successDurationMs: number
  failureDurationMs: number
  avgSuccessMs: number
  avgFailureMs: number
}

export interface WebSearchUsage {
  range: string
  days: number
  searches: number
  successes: number
  failures: number
  engines: EngineUsage[]
}

export interface TokenUsageRecord {
  keyId: string
  hourKey?: string
  requests: number
  cacheReadTokens?: number
  inputTokens?: number
  outputTokens?: number
}

export type WebSearchRange = "1d" | "7d" | "30d"

export function listKeys(): Promise<ApiKeyDetail[]> {
  return api<ApiKeyDetail[]>("/api/keys")
}

export interface CreatedKey {
  id: string
  name: string
  key: string
}
export function createKey(name: string): Promise<CreatedKey> {
  return api<CreatedKey>("/api/keys", { method: "POST", body: { name } })
}

export function deleteKey(id: string): Promise<{ ok: true }> {
  return api(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export function patchKey(id: string, body: KeyPatchBody): Promise<ApiKeyDetail> {
  return api<ApiKeyDetail>(`/api/keys/${encodeURIComponent(id)}`, { method: "PATCH", body })
}

export function copyWebSearchFrom(id: string, sourceId: string): Promise<ApiKeyDetail> {
  return api<ApiKeyDetail>(
    `/api/keys/${encodeURIComponent(id)}/copy-web-search-from/${encodeURIComponent(sourceId)}`,
    { method: "POST" },
  )
}

export function getWebSearchUsage(id: string, range: WebSearchRange): Promise<WebSearchUsage> {
  return api<WebSearchUsage>(`/api/keys/${encodeURIComponent(id)}/web-search-usage`, {
    query: { range },
  })
}

export function assignKey(id: string, body: { user_id?: string; email?: string }): Promise<{ ok: true }> {
  return api(`/api/keys/${encodeURIComponent(id)}/assign`, { method: "POST", body })
}

export function unassignKey(id: string, userId: string): Promise<{ ok: true }> {
  return api(`/api/keys/${encodeURIComponent(id)}/assign/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  })
}

// Quota usage = today's token-usage records for the key, weighted.
export function getTodayTokenUsage(keyId: string): Promise<TokenUsageRecord[]> {
  const now = new Date()
  const todayStart = now.toISOString().slice(0, 10) + "T00"
  const tomorrowStart = new Date(now.getTime() + 86400000).toISOString().slice(0, 10) + "T00"
  return api<TokenUsageRecord[]>("/api/token-usage", {
    query: { start: todayStart, end: tomorrowStart, key_id: keyId },
  })
}
