import { api, ApiError } from "./client"
import { adaptUsageRow, type ServerUsageRow } from "./usage"

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

export interface ApiKeyModelMapping {
  source: string
  destination: string
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
  can_manage_model_mappings: boolean
  model_mappings_enabled: boolean
  model_mappings: ApiKeyModelMapping[]
  model_mappings_invalid: boolean
  quota_requests_per_month: number | null
  quota_tokens_per_month: number | null
  quota_cost_per_month: number | null
  web_search_enabled: boolean
  web_search_langsearch_key: string | null
  web_search_langsearch_ref: KeyRefDescriptor | null
  web_search_tavily_key: string | null
  web_search_tavily_ref: KeyRefDescriptor | null
  web_search_ms_grounding_key: string | null
  web_search_ms_grounding_ref: KeyRefDescriptor | null
  web_search_jina_key: string | null
  web_search_jina_ref: KeyRefDescriptor | null
  web_search_passthrough_upstream: string | null
  web_search_passthrough_model: string | null
  web_search_priority: string[] | null
  assignees?: KeyAssigneeBrief[]
}

export interface KeyPatchBody {
  model_mappings_enabled?: boolean
  model_mappings?: ApiKeyModelMapping[]
  name?: string
  quota_requests_per_month?: number | null
  quota_tokens_per_month?: number | null
  quota_cost_per_month?: number | null
  web_search_enabled?: boolean
  web_search_langsearch_key?: string | null
  web_search_tavily_key?: string | null
  web_search_ms_grounding_key?: string | null
  web_search_priority?: string[] | null
  web_search_langsearch_ref?: string | null
  web_search_tavily_ref?: string | null
  web_search_ms_grounding_ref?: string | null
  web_search_jina_key?: string | null
  web_search_jina_ref?: string | null
  web_search_passthrough_upstream?: string | null
  web_search_passthrough_model?: string | null
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
  cacheCreationTokens?: number
  inputTokens?: number
  outputTokens?: number
  cost?: { totalUSD?: number } | null
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

// Quota usage = this UTC calendar month's token-usage records for the key,
// weighted. UTC month, not local: it must match the gateway's quota gate
// (data-plane/observability/quota.ts), which cannot know the caller's timezone.
// The server answers in the per-dimension `tokens: {...}` shape, so the rows go
// through the same adapter the usage tab uses.
export async function getMonthTokenUsage(keyId: string): Promise<TokenUsageRecord[]> {
  const now = new Date()
  const monthStartHour = (delta: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + delta, 1)).toISOString().slice(0, 10) + "T00"
  const rows = await api<ServerUsageRow[]>("/api/token-usage", {
    query: { start: monthStartHour(0), end: monthStartHour(1), key_id: keyId },
  })
  return rows.map(adaptUsageRow)
}

/** One fixed query run on the key's own engines — see the gateway's
 *  `test-connection.ts` for why this exists. */
export interface WebSearchTestResult {
  ok: boolean
  provider: string
  query: string
  results?: Array<{ title: string; url: string; previewText: string }>
  error?: { code: string; message: string }
}

export async function testKeyWebSearch(id: string): Promise<WebSearchTestResult> {
  try {
    return await api<WebSearchTestResult>(
      `/api/keys/${encodeURIComponent(id)}/web-search-test`,
      { method: "POST" },
    )
  } catch (e) {
    // The route answers 400 on a failed test, which `api` throws on — but a
    // failed test is a result, not a transport error. `ApiError` carries the
    // parsed body, so unwrap it rather than re-parsing the message.
    if (e instanceof ApiError) {
      const body = e.body as WebSearchTestResult | undefined
      if (body && typeof body.ok === "boolean") return body
    }
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, provider: "", query: "", error: { code: "request_failed", message } }
  }
}
