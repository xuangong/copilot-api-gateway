import type {
  ApiKey,
  ApiKeyRepo,
  CacheRepo,
  ClientPresence,
  ClientPresenceRepo,
  DeviceCode,
  DeviceCodeRepo,
  GitHubAccount,
  GitHubRepo,
  UpstreamRecord,
  UpstreamRepo,
  InviteCode,
  InviteCodeRepo,
  KeyAssignment,
  KeyAssignmentRepo,
  LatencyRecord,
  LatencyRepo,
  ObservabilityShare,
  ObservabilityShareRepo,
  PerformanceBucketRecord,
  PerformanceMetricScope,
  PerformanceRecordInput,
  PerformanceRepo,
  PerformanceSummaryRecord,
  Repo,
  ResponsesItemRecord,
  ResponsesItemsRepo,
  SessionRepo,
  UsageRecord,
  UsageRepo,
  User,
  UserRepo,
  UserSession,
  WebSearchEngineUsageRecord,
  WebSearchEngineUsageRepo,
  WebSearchUsageRecord,
  WebSearchUsageRepo,
} from "../types"
import { parseStoredApiKeyModelMappings } from "../../shared/api-key-model-mappings.ts"
import type { ApiKeyId, DeviceCodeToken, GitHubAccountId, InviteCodeId, ResponsesItemId, SessionToken, UpstreamId, UserId } from "../branded-ids.ts"
import { latencyBucketForMs } from "../../repo/performance-histogram.ts"
import type { SqlExecutor } from "./executor"
import { BILLING_DIMENSIONS, unitPriceForDimension } from "@vibe-llm/protocols/common"
import type { BillingDimension, ModelPricing } from "@vibe-llm/protocols/common"
import { UpstreamGoneError } from "@vibe-core/upstream-repo"
import type { BackoffRow, ProxyBackoffRepo, ProxyFallbackEntry, ProxyRecord, ProxyRepo } from "@vibe-core/proxy-repo"

const API_KEY_COLS = "id, name, key, created_at, last_used_at, owner_id, quota_requests_per_month, quota_tokens_per_month, quota_cost_per_month, web_search_enabled, web_search_langsearch_key, web_search_tavily_key, web_search_ms_grounding_key, web_search_priority, web_search_langsearch_ref, web_search_tavily_ref, web_search_ms_grounding_ref, web_search_jina_key, web_search_jina_ref, web_search_passthrough_upstream, web_search_passthrough_model, dump_retention_seconds, model_mappings_enabled, model_mappings"
const GITHUB_COLS = "user_id, token, account_type, login, name, avatar_url, owner_id, enabled, sort_order, flag_overrides, updated_at, github_host, source"
const UPSTREAM_COLS = "id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, state_json, proxy_fallback_list_json, created_at, updated_at"
const USAGE_DIM_COLS = "key_id, model, upstream, model_key, client, hour, dimension, tokens, unit_price"
const USAGE_REQ_COLS = "key_id, model, upstream, model_key, client, hour, requests"
const LATENCY_COLS = "key_id, model, hour, colo, stream, requests, total_ms, upstream_ms, ttfb_ms, token_miss"
const USER_COLS = "id, name, email, avatar_url, created_at, disabled, last_login_at, user_key, password_hash"
const INVITE_COLS = "id, code, name, email, created_at, used_at, used_by"
const SESSION_COLS = "token, user_id, created_at, expires_at"
const PRESENCE_COLS = "client_id, client_name, key_id, key_name, owner_id, gateway_url, last_seen_at"
const WS_USAGE_COLS = "key_id, hour, searches, successes, failures"
const WS_ENGINE_COLS = "key_id, engine_id, hour, attempts, successes, failures, empty_results, total_results, success_duration_ms, failure_duration_ms"
const KEY_ASSIGN_COLS = "key_id, user_id, assigned_by, assigned_at"
const SHARE_COLS = "owner_id, viewer_id, granted_by, granted_at"
const DEVICE_COLS = "device_code, user_code, expires_at, user_id, session_token, created_at"
const PERF_SUMMARY_COLS = "hour, metric_scope, key_id, model, upstream, source_api, target_api, stream, runtime_location, operation, requests, errors, total_ms_sum"
const PERF_BUCKET_COLS = "hour, metric_scope, key_id, model, upstream, source_api, target_api, stream, runtime_location, operation, lower_ms, upper_ms, count"
const RESPONSES_ITEMS_COLS = "id, api_key_id, kind, item_json, private_json, created_at, expires_at"

function toApiKey(row: any): ApiKey {
  const modelMappings = parseStoredApiKeyModelMappings(row.model_mappings)
  if (!modelMappings.ok) {
    const safeFields: Record<string, string | number> = { event: "invalid_api_key_model_mappings", reason: modelMappings.reason }
    if (modelMappings.index !== undefined) safeFields.index = modelMappings.index
    if (modelMappings.field !== undefined) safeFields.field = modelMappings.field
    console.warn(safeFields)
  }
  let priority: string[] | undefined
  if (typeof row.web_search_priority === "string" && row.web_search_priority.length > 0) {
    try {
      const parsed = JSON.parse(row.web_search_priority)
      if (Array.isArray(parsed)) priority = parsed.filter((v: unknown): v is string => typeof v === "string")
    } catch {}
  }
  return {
    id: row.id as ApiKeyId,
    name: row.name,
    key: row.key,
    createdAt: row.created_at,
    modelMappingsEnabled: modelMappings.ok ? row.model_mappings_enabled === 1 : false,
    modelMappings: modelMappings.ok ? modelMappings.value : [],
    modelMappingsInvalid: !modelMappings.ok,
    lastUsedAt: row.last_used_at ?? undefined,
    ownerId: row.owner_id ? (row.owner_id as UserId) : undefined,
    quotaRequestsPerMonth: row.quota_requests_per_month ?? undefined,
    quotaTokensPerMonth: row.quota_tokens_per_month ?? undefined,
    quotaCostPerMonth: row.quota_cost_per_month ?? undefined,
    webSearchEnabled: row.web_search_enabled === 1,
    webSearchLangsearchKey: row.web_search_langsearch_key ?? undefined,
    webSearchTavilyKey: row.web_search_tavily_key ?? undefined,
    webSearchMsGroundingKey: row.web_search_ms_grounding_key ?? undefined,
    webSearchPriority: priority,
    webSearchLangsearchRef: row.web_search_langsearch_ref ?? undefined,
    webSearchTavilyRef: row.web_search_tavily_ref ?? undefined,
    webSearchMsGroundingRef: row.web_search_ms_grounding_ref ?? undefined,
    webSearchJinaKey: row.web_search_jina_key ?? undefined,
    webSearchJinaRef: row.web_search_jina_ref ?? undefined,
    webSearchPassthroughUpstream: row.web_search_passthrough_upstream ?? undefined,
    webSearchPassthroughModel: row.web_search_passthrough_model ?? undefined,
    dumpRetentionSeconds: row.dump_retention_seconds ?? null,
  }
}

function toGitHubAccount(row: any): GitHubAccount {
  let flagOverrides: Record<string, boolean> | undefined
  if (typeof row.flag_overrides === "string" && row.flag_overrides.length > 0) {
    try {
      const parsed = JSON.parse(row.flag_overrides)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        flagOverrides = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "boolean") flagOverrides[k] = v
        }
      }
    } catch {}
  }
  return {
    token: row.token,
    accountType: row.account_type,
    ownerId: row.owner_id ? (row.owner_id as UserId) : undefined,
    user: { id: row.user_id as GitHubAccountId, login: row.login, name: row.name, avatar_url: row.avatar_url },
    enabled: row.enabled === undefined ? undefined : row.enabled === 1,
    sortOrder: row.sort_order ?? undefined,
    flagOverrides,
    updatedAt: row.updated_at ?? undefined,
    githubHost: row.github_host ?? undefined,
    source: (row.source === "device-flow" || row.source === "paste") ? row.source : undefined,
  }
}

function parseBooleanRecord(raw: unknown): Record<string, boolean> {
  if (typeof raw !== "string" || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "boolean") out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of v) {
      if (typeof item !== "string") continue
      const trimmed = item.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
    }
    return out
  } catch {
    return []
  }
}

function parseState(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "string" || raw.length === 0) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function toUpstreamRecord(row: any): UpstreamRecord<unknown> {
  return {
    id: row.id,
    ownerId: row.owner_id || undefined,
    provider: row.provider,
    name: row.name,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order ?? 0,
    config: parseObject(row.config_json),
    flagOverrides: parseBooleanRecord(row.flag_overrides),
    disabledPublicModelIds: parseStringArray(row.disabled_public_model_ids),
    state: parseState(row.state_json),
    proxyFallbackList: parseProxyFallbackList(row.proxy_fallback_list_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseProxyFallbackList(json: unknown): ProxyFallbackEntry[] {
  if (typeof json !== "string" || json.length === 0) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    const out: ProxyFallbackEntry[] = []
    for (const raw of parsed) {
      if (typeof raw !== "object" || raw === null || typeof raw.id !== "string") continue
      const entry: ProxyFallbackEntry = { id: raw.id }
      if (Array.isArray(raw.colos)) {
        const colos = raw.colos.filter((v: unknown): v is string => typeof v === "string")
        if (colos.length > 0) entry.colos = colos
      }
      out.push(entry)
    }
    return out
  } catch {
    return []
  }
}

function toLatencyRecord(r: any): LatencyRecord {
  return {
    keyId: r.key_id as ApiKeyId,
    model: r.model,
    hour: r.hour,
    colo: r.colo,
    stream: r.stream === 1,
    requests: r.requests,
    totalMs: r.total_ms,
    upstreamMs: r.upstream_ms,
    ttfbMs: r.ttfb_ms,
    tokenMiss: r.token_miss,
  }
}

function toUser(row: any): User {
  return {
    id: row.id as UserId,
    name: row.name,
    email: row.email ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    createdAt: row.created_at,
    disabled: row.disabled === 1,
    lastLoginAt: row.last_login_at ?? undefined,
    userKey: row.user_key ?? undefined,
    passwordHash: row.password_hash ?? undefined,
  }
}

function toInviteCode(row: any): InviteCode {
  return {
    id: row.id as InviteCodeId,
    code: row.code,
    name: row.name,
    email: row.email ?? undefined,
    createdAt: row.created_at,
    usedAt: row.used_at ?? undefined,
    usedBy: row.used_by ? (row.used_by as UserId) : undefined,
  }
}

function toPresence(row: any): ClientPresence {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    keyId: row.key_id ? (row.key_id as ApiKeyId) : null,
    keyName: row.key_name ?? null,
    ownerId: row.owner_id ? (row.owner_id as UserId) : null,
    gatewayUrl: row.gateway_url ?? null,
    lastSeenAt: row.last_seen_at,
  }
}

function toDeviceCode(row: any): DeviceCode {
  return {
    deviceCode: row.device_code as DeviceCodeToken,
    userCode: row.user_code,
    expiresAt: row.expires_at,
    userId: row.user_id ? (row.user_id as UserId) : undefined,
    sessionToken: row.session_token ? (row.session_token as SessionToken) : undefined,
    createdAt: row.created_at,
  }
}

// Build the WHERE clause + binds for the keyIds / keyId / none branch shared
// by usage.query, latency.query, web_search_usage.query, web_search_engine_usage.query.
function buildKeyIdRangeQuery(table: string, cols: string, opts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string }): { sql: string; binds: unknown[] } {
  if (opts.keyIds && opts.keyIds.length > 0) {
    const placeholders = opts.keyIds.map(() => "?").join(",")
    return {
      sql: `SELECT ${cols} FROM ${table} WHERE key_id IN (${placeholders}) AND hour >= ? AND hour < ? ORDER BY hour`,
      binds: [...opts.keyIds, opts.start, opts.end],
    }
  }
  if (opts.keyId) {
    return {
      sql: `SELECT ${cols} FROM ${table} WHERE key_id = ? AND hour >= ? AND hour < ? ORDER BY hour`,
      binds: [opts.keyId, opts.start, opts.end],
    }
  }
  return {
    sql: `SELECT ${cols} FROM ${table} WHERE hour >= ? AND hour < ? ORDER BY hour`,
    binds: [opts.start, opts.end],
  }
}

class SharedApiKeyRepo implements ApiKeyRepo {
  constructor(private x: SqlExecutor) {}

  async list(): Promise<ApiKey[]> {
    return (await this.x.all(`SELECT ${API_KEY_COLS} FROM api_keys ORDER BY created_at`, [])).map(toApiKey)
  }

  async listByOwner(ownerId: UserId): Promise<ApiKey[]> {
    return (await this.x.all(`SELECT ${API_KEY_COLS} FROM api_keys WHERE owner_id = ? ORDER BY created_at`, [ownerId])).map(toApiKey)
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const row = await this.x.first(`SELECT ${API_KEY_COLS} FROM api_keys WHERE key = ?`, [rawKey])
    return row ? toApiKey(row) : null
  }

  async getById(id: ApiKeyId): Promise<ApiKey | null> {
    const row = await this.x.first(`SELECT ${API_KEY_COLS} FROM api_keys WHERE id = ?`, [id])
    return row ? toApiKey(row) : null
  }

  async save(key: ApiKey): Promise<void> {
    await this.x.run(
      `INSERT INTO api_keys (${API_KEY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, key = excluded.key, last_used_at = excluded.last_used_at, owner_id = excluded.owner_id, quota_requests_per_month = excluded.quota_requests_per_month, quota_tokens_per_month = excluded.quota_tokens_per_month, quota_cost_per_month = excluded.quota_cost_per_month, web_search_enabled = excluded.web_search_enabled, web_search_langsearch_key = excluded.web_search_langsearch_key, web_search_tavily_key = excluded.web_search_tavily_key, web_search_ms_grounding_key = excluded.web_search_ms_grounding_key, web_search_priority = excluded.web_search_priority, web_search_langsearch_ref = excluded.web_search_langsearch_ref, web_search_tavily_ref = excluded.web_search_tavily_ref, web_search_ms_grounding_ref = excluded.web_search_ms_grounding_ref, web_search_jina_key = excluded.web_search_jina_key, web_search_jina_ref = excluded.web_search_jina_ref, web_search_passthrough_upstream = excluded.web_search_passthrough_upstream, web_search_passthrough_model = excluded.web_search_passthrough_model, dump_retention_seconds = excluded.dump_retention_seconds, model_mappings_enabled = excluded.model_mappings_enabled, model_mappings = excluded.model_mappings`,
      [
        key.id, key.name, key.key, key.createdAt, key.lastUsedAt ?? null, key.ownerId ?? null,
        key.quotaRequestsPerMonth ?? null, key.quotaTokensPerMonth ?? null, key.quotaCostPerMonth ?? null,
        key.webSearchEnabled ? 1 : 0,
        key.webSearchLangsearchKey ?? null, key.webSearchTavilyKey ?? null, key.webSearchMsGroundingKey ?? null,
        key.webSearchPriority ? JSON.stringify(key.webSearchPriority) : null,
        key.webSearchLangsearchRef ?? null, key.webSearchTavilyRef ?? null, key.webSearchMsGroundingRef ?? null,
        key.webSearchJinaKey ?? null, key.webSearchJinaRef ?? null,
        key.webSearchPassthroughUpstream ?? null, key.webSearchPassthroughModel ?? null,
        key.dumpRetentionSeconds ?? null,
        key.modelMappingsEnabled ? 1 : 0,
        JSON.stringify(key.modelMappings),
      ],
    )
  }

  async delete(id: ApiKeyId): Promise<boolean> {
    const r = await this.x.run("DELETE FROM api_keys WHERE id = ?", [id])
    return r.changes > 0
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM api_keys", [])
  }

  async touchLastUsed(id: ApiKeyId): Promise<void> {
    await this.x.run(
      `UPDATE api_keys SET last_used_at = ? WHERE id = ?`,
      [new Date().toISOString(), id],
    )
  }
}

class SharedGitHubRepo implements GitHubRepo {
  constructor(private x: SqlExecutor) {}

  async listAccounts(): Promise<GitHubAccount[]> {
    return (await this.x.all(`SELECT ${GITHUB_COLS} FROM github_accounts`, [])).map(toGitHubAccount)
  }

  async listAccountsByOwner(ownerId: UserId): Promise<GitHubAccount[]> {
    return (await this.x.all(`SELECT ${GITHUB_COLS} FROM github_accounts WHERE owner_id = ?`, [ownerId])).map(toGitHubAccount)
  }

  async getAccount(userId: GitHubAccountId, ownerId?: UserId): Promise<GitHubAccount | null> {
    const row = await this.x.first(`SELECT ${GITHUB_COLS} FROM github_accounts WHERE user_id = ? AND owner_id = ?`, [userId, ownerId ?? ""])
    return row ? toGitHubAccount(row) : null
  }

  async saveAccount(userId: GitHubAccountId, account: GitHubAccount): Promise<void> {
    const flagOverridesJson = account.flagOverrides ? JSON.stringify(account.flagOverrides) : "{}"
    const updatedAt = account.updatedAt ?? new Date().toISOString()
    await this.x.run(
      `INSERT INTO github_accounts (${GITHUB_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, owner_id) DO UPDATE SET token = excluded.token, account_type = excluded.account_type, login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url, enabled = excluded.enabled, sort_order = excluded.sort_order, flag_overrides = excluded.flag_overrides, updated_at = excluded.updated_at, github_host = excluded.github_host, source = excluded.source`,
      [
        userId, account.token, account.accountType, account.user.login, account.user.name, account.user.avatar_url, account.ownerId ?? "",
        account.enabled === false ? 0 : 1,
        account.sortOrder ?? 0,
        flagOverridesJson,
        updatedAt,
        account.githubHost ?? "github.com",
        account.source ?? null,
      ],
    )
  }

  async deleteAccount(userId: GitHubAccountId, ownerId?: UserId): Promise<void> {
    if (ownerId !== undefined) {
      await this.x.run("DELETE FROM github_accounts WHERE user_id = ? AND owner_id = ?", [userId, ownerId])
    } else {
      await this.x.run("DELETE FROM github_accounts WHERE user_id = ?", [userId])
    }
  }

  async deleteAllAccounts(): Promise<void> {
    await this.x.run("DELETE FROM github_accounts", [])
    await this.clearActiveId()
  }

  async getActiveId(): Promise<GitHubAccountId | null> {
    const row = await this.x.first<{ value: string }>("SELECT value FROM config WHERE key = ?", ["active_github_account"])
    return row ? (Number(row.value) as GitHubAccountId) : null
  }

  async setActiveId(userId: GitHubAccountId): Promise<void> {
    await this.x.run("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", ["active_github_account", String(userId)])
  }

  async clearActiveId(): Promise<void> {
    await this.x.run("DELETE FROM config WHERE key = ?", ["active_github_account"])
  }

  async getActiveIdForUser(ownerId: UserId): Promise<GitHubAccountId | null> {
    const row = await this.x.first<{ value: string }>("SELECT value FROM config WHERE key = ?", [`active_github_account:${ownerId}`])
    return row ? (Number(row.value) as GitHubAccountId) : null
  }

  async setActiveIdForUser(ownerId: UserId, userId: GitHubAccountId): Promise<void> {
    await this.x.run("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [`active_github_account:${ownerId}`, String(userId)])
  }

  async clearActiveIdForUser(ownerId: UserId): Promise<void> {
    await this.x.run("DELETE FROM config WHERE key = ?", [`active_github_account:${ownerId}`])
  }
}

class SharedUpstreamRepo implements UpstreamRepo {
  constructor(private x: SqlExecutor) {}

  async list(opts: { ownerId?: UserId; includeDisabled?: boolean } = {}): Promise<UpstreamRecord<unknown>[]> {
    const where: string[] = []
    const binds: unknown[] = []
    if (opts.ownerId !== undefined) {
      where.push("owner_id = ?")
      binds.push(opts.ownerId)
    }
    if (!opts.includeDisabled) where.push("enabled = 1")
    const sql = `SELECT ${UPSTREAM_COLS} FROM upstreams${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY sort_order ASC, created_at ASC, id ASC`
    return (await this.x.all(sql, binds)).map(toUpstreamRecord)
  }

  async getById<TState = unknown>(id: UpstreamId): Promise<UpstreamRecord<TState> | null> {
    const row = await this.x.first(`SELECT ${UPSTREAM_COLS} FROM upstreams WHERE id = ?`, [id])
    return row ? (toUpstreamRecord(row) as UpstreamRecord<TState>) : null
  }

  async save(upstream: UpstreamRecord<unknown>): Promise<void> {
    await this.x.run(
      `INSERT INTO upstreams (${UPSTREAM_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, provider = excluded.provider, name = excluded.name, enabled = excluded.enabled, sort_order = excluded.sort_order, config_json = excluded.config_json, flag_overrides = excluded.flag_overrides, disabled_public_model_ids = excluded.disabled_public_model_ids, state_json = excluded.state_json, proxy_fallback_list_json = excluded.proxy_fallback_list_json, updated_at = excluded.updated_at`,
      [
        upstream.id,
        upstream.ownerId ?? "",
        upstream.provider,
        upstream.name,
        upstream.enabled ? 1 : 0,
        upstream.sortOrder,
        JSON.stringify(upstream.config ?? {}),
        JSON.stringify(upstream.flagOverrides ?? {}),
        JSON.stringify(upstream.disabledPublicModelIds ?? []),
        upstream.state === null || upstream.state === undefined ? null : JSON.stringify(upstream.state),
        JSON.stringify(upstream.proxyFallbackList ?? []),
        upstream.createdAt,
        upstream.updatedAt,
      ],
    )
  }

  async delete(id: UpstreamId): Promise<boolean> {
    const r = await this.x.run("DELETE FROM upstreams WHERE id = ?", [id])
    return r.changes > 0
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM upstreams", [])
  }

  async saveState<TState>(id: UpstreamId, updater: (current: TState) => TState): Promise<void> {
    // Serial read-modify-write: SqlExecutor has no tx primitive, so concurrent
    // rotations are last-write-wins. Codex OAuth rotation is bounded by a single
    // refresh call in-flight per upstream, so contention is negligible.
    const row = await this.x.first<{ state_json: string | null }>(
      "SELECT state_json FROM upstreams WHERE id = ?",
      [id],
    )
    if (!row) throw new UpstreamGoneError(id)
    const current = parseState(row.state_json) as TState
    const next = updater(current)
    const nextJson = next === null || next === undefined ? null : JSON.stringify(next)
    await this.x.run(
      "UPDATE upstreams SET state_json = ?, updated_at = ? WHERE id = ?",
      [nextJson, new Date().toISOString(), id],
    )
  }
}

interface UsageDimensionRow {
  key_id: string
  model: string
  upstream: string | null
  model_key: string
  client: string
  hour: string
  dimension: string
  tokens: number
  unit_price: number | null
}

interface UsageRequestRow {
  key_id: string
  model: string
  upstream: string | null
  model_key: string
  client: string
  hour: string
  requests: number
}

function dimensionRows(record: UsageRecord): { dimension: BillingDimension; tokens: number; unitPrice: number | null }[] {
  return BILLING_DIMENSIONS.flatMap((dimension) => {
    const tokens = record.tokens[dimension] ?? 0
    return tokens > 0 ? [{ dimension, tokens, unitPrice: unitPriceForDimension(record.cost, dimension) }] : []
  })
}

function usageBucketKey(row: { key_id: string; model: string; upstream: string | null; model_key: string; client: string; hour: string }): string {
  return [row.key_id, row.model, row.upstream ?? "", row.model_key, row.client, row.hour].join("\0")
}

// Reassemble per-bucket UsageRecords from the two narrow tables. The dimension
// rows carry the disjoint counts and the per-dimension unit_price snapshot,
// which we fold back into a ModelPricing snapshot; usage_requests carries the
// request count. A bucket may appear in either table independently.
function assembleUsageRecords(dimensions: readonly UsageDimensionRow[], requests: readonly UsageRequestRow[]): UsageRecord[] {
  const byBucket = new Map<string, UsageRecord>()

  const ensureRecord = (row: { key_id: string; model: string; upstream: string | null; model_key: string; client: string; hour: string }): UsageRecord => {
    const key = usageBucketKey(row)
    let record = byBucket.get(key)
    if (!record) {
      record = {
        keyId: row.key_id as ApiKeyId,
        model: row.model,
        upstream: row.upstream ?? null,
        modelKey: row.model_key,
        client: row.client || "",
        hour: row.hour,
        requests: 0,
        tokens: {},
        cost: null,
      }
      byBucket.set(key, record)
    }
    return record
  }

  const pricingByBucket = new Map<string, ModelPricing>()
  for (const row of dimensions) {
    const record = ensureRecord(row)
    record.tokens[row.dimension as BillingDimension] = row.tokens
    if (row.unit_price !== null) {
      const key = usageBucketKey(row)
      const pricing = pricingByBucket.get(key) ?? {}
      pricing[row.dimension as BillingDimension] = row.unit_price
      pricingByBucket.set(key, pricing)
    }
  }
  for (const [key, pricing] of pricingByBucket) {
    const record = byBucket.get(key)
    if (record) record.cost = pricing
  }

  for (const row of requests) ensureRecord(row).requests = row.requests

  return [...byBucket.values()].sort((a, b) => a.hour.localeCompare(b.hour))
}

class SharedUsageRepo implements UsageRepo {
  constructor(private x: SqlExecutor) {}

  async record(r: UsageRecord): Promise<void> {
    const upstream = r.upstream ?? null
    const client = r.client || ""
    for (const row of dimensionRows(r)) {
      await this.x.run(
        `INSERT INTO usage (${USAGE_DIM_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key_id, model, COALESCE(upstream, ''), model_key, client, hour, dimension) DO UPDATE SET
           tokens = tokens + excluded.tokens,
           unit_price = COALESCE(unit_price, excluded.unit_price)`,
        [r.keyId, r.model, upstream, r.modelKey, client, r.hour, row.dimension, row.tokens, row.unitPrice],
      )
    }
    await this.x.run(
      `INSERT INTO usage_requests (${USAGE_REQ_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_id, model, COALESCE(upstream, ''), model_key, client, hour) DO UPDATE SET
         requests = requests + excluded.requests`,
      [r.keyId, r.model, upstream, r.modelKey, client, r.hour, r.requests],
    )
  }

  async set(r: UsageRecord): Promise<void> {
    const upstream = r.upstream ?? null
    const client = r.client || ""
    // Replacement upsert: clear the bucket's existing dimension rows first so
    // dimensions absent from the new record do not linger.
    await this.x.run(
      "DELETE FROM usage WHERE key_id = ? AND model = ? AND COALESCE(upstream, '') = COALESCE(?, '') AND model_key = ? AND client = ? AND hour = ?",
      [r.keyId, r.model, upstream, r.modelKey, client, r.hour],
    )
    for (const row of dimensionRows(r)) {
      await this.x.run(
        `INSERT INTO usage (${USAGE_DIM_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.keyId, r.model, upstream, r.modelKey, client, r.hour, row.dimension, row.tokens, row.unitPrice],
      )
    }
    await this.x.run(
      `INSERT INTO usage_requests (${USAGE_REQ_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_id, model, COALESCE(upstream, ''), model_key, client, hour) DO UPDATE SET
         requests = excluded.requests`,
      [r.keyId, r.model, upstream, r.modelKey, client, r.hour, r.requests],
    )
  }

  async query(opts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string }): Promise<UsageRecord[]> {
    const dimQuery = buildKeyIdRangeQuery("usage", USAGE_DIM_COLS, opts)
    const reqQuery = buildKeyIdRangeQuery("usage_requests", USAGE_REQ_COLS, opts)
    const [dimensions, requests] = await Promise.all([
      this.x.all<UsageDimensionRow>(dimQuery.sql, dimQuery.binds),
      this.x.all<UsageRequestRow>(reqQuery.sql, reqQuery.binds),
    ])
    return assembleUsageRecords(dimensions, requests)
  }

  async listAll(): Promise<UsageRecord[]> {
    const [dimensions, requests] = await Promise.all([
      this.x.all<UsageDimensionRow>(`SELECT ${USAGE_DIM_COLS} FROM usage ORDER BY hour`, []),
      this.x.all<UsageRequestRow>(`SELECT ${USAGE_REQ_COLS} FROM usage_requests ORDER BY hour`, []),
    ])
    return assembleUsageRecords(dimensions, requests)
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM usage", [])
    await this.x.run("DELETE FROM usage_requests", [])
  }
}

class SharedCacheRepo implements CacheRepo {
  constructor(private x: SqlExecutor) {}

  async get(key: string): Promise<string | null> {
    const row = await this.x.first<{ value: string }>("SELECT value FROM config WHERE key = ?", [key])
    return row?.value ?? null
  }

  async set(key: string, value: string): Promise<void> {
    await this.x.run("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value])
  }

  async delete(key: string): Promise<void> {
    await this.x.run("DELETE FROM config WHERE key = ?", [key])
  }
}

class SharedLatencyRepo implements LatencyRepo {
  constructor(private x: SqlExecutor) {}

  async record(entry: { keyId: ApiKeyId; model: string; hour: string; colo: string; stream: boolean; totalMs: number; upstreamMs: number; ttfbMs: number; tokenMiss: boolean }): Promise<void> {
    await this.x.run(
      `INSERT INTO latency (${LATENCY_COLS}) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT (key_id, model, hour, colo, stream) DO UPDATE SET requests = requests + 1, total_ms = total_ms + excluded.total_ms, upstream_ms = upstream_ms + excluded.upstream_ms, ttfb_ms = ttfb_ms + excluded.ttfb_ms, token_miss = token_miss + excluded.token_miss`,
      [entry.keyId, entry.model, entry.hour, entry.colo, entry.stream ? 1 : 0, entry.totalMs, entry.upstreamMs, entry.ttfbMs, entry.tokenMiss ? 1 : 0],
    )
  }

  async query(opts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string }): Promise<LatencyRecord[]> {
    const { sql, binds } = buildKeyIdRangeQuery("latency", LATENCY_COLS, opts)
    return (await this.x.all(sql, binds)).map(toLatencyRecord)
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM latency", [])
  }
}

class SharedUserRepo implements UserRepo {
  constructor(private x: SqlExecutor) {}

  async create(user: User): Promise<void> {
    await this.x.run(
      `INSERT INTO users (${USER_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user.id, user.name, user.email ?? null, user.avatarUrl ?? null, user.createdAt, user.disabled ? 1 : 0, user.lastLoginAt ?? null, user.userKey ?? null, user.passwordHash ?? null],
    )
  }

  async getById(id: UserId): Promise<User | null> {
    const row = await this.x.first(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [id])
    return row ? toUser(row) : null
  }

  async findByKey(userKey: string): Promise<User | null> {
    const row = await this.x.first(`SELECT ${USER_COLS} FROM users WHERE user_key = ?`, [userKey])
    return row ? toUser(row) : null
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.x.first(`SELECT ${USER_COLS} FROM users WHERE email = ?`, [email])
    return row ? toUser(row) : null
  }

  async list(): Promise<User[]> {
    return (await this.x.all(`SELECT ${USER_COLS} FROM users ORDER BY created_at`, [])).map(toUser)
  }

  async update(id: UserId, fields: Partial<Pick<User, "name" | "email" | "avatarUrl" | "disabled" | "lastLoginAt" | "userKey" | "passwordHash">>): Promise<void> {
    const sets: string[] = []
    const binds: unknown[] = []
    if (fields.name !== undefined) { sets.push("name = ?"); binds.push(fields.name) }
    if (fields.email !== undefined) { sets.push("email = ?"); binds.push(fields.email) }
    if (fields.avatarUrl !== undefined) { sets.push("avatar_url = ?"); binds.push(fields.avatarUrl) }
    if (fields.disabled !== undefined) { sets.push("disabled = ?"); binds.push(fields.disabled ? 1 : 0) }
    if (fields.lastLoginAt !== undefined) { sets.push("last_login_at = ?"); binds.push(fields.lastLoginAt) }
    if (fields.userKey !== undefined) { sets.push("user_key = ?"); binds.push(fields.userKey) }
    if (fields.passwordHash !== undefined) { sets.push("password_hash = ?"); binds.push(fields.passwordHash) }
    if (sets.length === 0) return
    binds.push(id)
    await this.x.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, binds)
  }

  async delete(id: UserId): Promise<void> {
    await this.x.run("DELETE FROM users WHERE id = ?", [id])
  }
}

class SharedInviteCodeRepo implements InviteCodeRepo {
  constructor(private x: SqlExecutor) {}

  async create(code: InviteCode): Promise<void> {
    await this.x.run(
      `INSERT INTO invite_codes (${INVITE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [code.id, code.code, code.name, code.email ?? null, code.createdAt, code.usedAt ?? null, code.usedBy ?? null],
    )
  }

  async findByCode(code: string): Promise<InviteCode | null> {
    const row = await this.x.first(`SELECT ${INVITE_COLS} FROM invite_codes WHERE code = ?`, [code])
    return row ? toInviteCode(row) : null
  }

  async list(): Promise<InviteCode[]> {
    return (await this.x.all(`SELECT ${INVITE_COLS} FROM invite_codes ORDER BY created_at DESC`, [])).map(toInviteCode)
  }

  async markUsed(id: InviteCodeId, userId: UserId): Promise<void> {
    await this.x.run("UPDATE invite_codes SET used_at = ?, used_by = ? WHERE id = ?", [new Date().toISOString(), userId, id])
  }

  async clearUsedBy(userId: UserId): Promise<void> {
    await this.x.run("UPDATE invite_codes SET used_by = NULL WHERE used_by = ?", [userId])
  }

  async delete(id: InviteCodeId): Promise<void> {
    await this.x.run("DELETE FROM invite_codes WHERE id = ?", [id])
  }
}

class SharedSessionRepo implements SessionRepo {
  constructor(private x: SqlExecutor) {}

  async create(session: UserSession): Promise<void> {
    await this.x.run(`INSERT INTO user_sessions (${SESSION_COLS}) VALUES (?, ?, ?, ?)`, [session.token, session.userId, session.createdAt, session.expiresAt])
  }

  async findByToken(token: SessionToken): Promise<UserSession | null> {
    const row = await this.x.first<any>(`SELECT ${SESSION_COLS} FROM user_sessions WHERE token = ?`, [token])
    return row ? { token: row.token as SessionToken, userId: row.user_id as UserId, createdAt: row.created_at, expiresAt: row.expires_at } : null
  }

  async deleteByUserId(userId: UserId): Promise<void> {
    await this.x.run("DELETE FROM user_sessions WHERE user_id = ?", [userId])
  }

  async deleteExpired(): Promise<void> {
    await this.x.run("DELETE FROM user_sessions WHERE expires_at < ?", [new Date().toISOString()])
  }
}

class SharedClientPresenceRepo implements ClientPresenceRepo {
  constructor(private x: SqlExecutor) {}

  async upsert(p: ClientPresence): Promise<void> {
    await this.x.run(
      `INSERT INTO client_presence (${PRESENCE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (client_id) DO UPDATE SET client_name = excluded.client_name, key_id = excluded.key_id, key_name = excluded.key_name, owner_id = excluded.owner_id, gateway_url = excluded.gateway_url, last_seen_at = excluded.last_seen_at`,
      [p.clientId, p.clientName, p.keyId ?? null, p.keyName ?? null, p.ownerId ?? null, p.gatewayUrl ?? null, p.lastSeenAt],
    )
  }

  async list(): Promise<ClientPresence[]> {
    return (await this.x.all(`SELECT ${PRESENCE_COLS} FROM client_presence ORDER BY last_seen_at DESC`, [])).map(toPresence)
  }

  async listByOwner(ownerId: UserId): Promise<ClientPresence[]> {
    return (await this.x.all(`SELECT ${PRESENCE_COLS} FROM client_presence WHERE owner_id = ? ORDER BY last_seen_at DESC`, [ownerId])).map(toPresence)
  }

  async listByKeyIds(keyIds: ApiKeyId[]): Promise<ClientPresence[]> {
    if (keyIds.length === 0) return []
    const placeholders = keyIds.map(() => "?").join(",")
    return (await this.x.all(`SELECT ${PRESENCE_COLS} FROM client_presence WHERE key_id IN (${placeholders}) ORDER BY last_seen_at DESC`, keyIds)).map(toPresence)
  }

  async pruneStale(olderThanMinutes: number): Promise<void> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString()
    await this.x.run("DELETE FROM client_presence WHERE last_seen_at < ?", [cutoff])
  }
}

class SharedWebSearchUsageRepo implements WebSearchUsageRepo {
  constructor(private x: SqlExecutor) {}

  async record(keyId: ApiKeyId, hour: string, success: boolean): Promise<void> {
    if (success) {
      await this.x.run(
        `INSERT INTO web_search_usage (${WS_USAGE_COLS}) VALUES (?, ?, 1, 1, 0)
         ON CONFLICT (key_id, hour) DO UPDATE SET searches = searches + 1, successes = successes + 1`,
        [keyId, hour],
      )
    } else {
      await this.x.run(
        `INSERT INTO web_search_usage (${WS_USAGE_COLS}) VALUES (?, ?, 1, 0, 1)
         ON CONFLICT (key_id, hour) DO UPDATE SET searches = searches + 1, failures = failures + 1`,
        [keyId, hour],
      )
    }
  }

  async query(opts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string }): Promise<WebSearchUsageRecord[]> {
    const { sql, binds } = buildKeyIdRangeQuery("web_search_usage", WS_USAGE_COLS, opts)
    const rows = await this.x.all<any>(sql, binds)
    return rows.map((r) => ({ keyId: r.key_id as ApiKeyId, hour: r.hour, searches: r.searches, successes: r.successes, failures: r.failures }))
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM web_search_usage", [])
  }
}

class SharedWebSearchEngineUsageRepo implements WebSearchEngineUsageRepo {
  constructor(private x: SqlExecutor) {}

  async record(keyId: ApiKeyId, engineId: string, hour: string, attempt: { ok: boolean; resultCount: number; durationMs: number }): Promise<void> {
    const successInc = attempt.ok ? 1 : 0
    const failureInc = attempt.ok ? 0 : 1
    const emptyInc = attempt.ok && attempt.resultCount === 0 ? 1 : 0
    const successDur = attempt.ok ? attempt.durationMs : 0
    const failureDur = attempt.ok ? 0 : attempt.durationMs
    await this.x.run(
      `INSERT INTO web_search_engine_usage (${WS_ENGINE_COLS}) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_id, engine_id, hour) DO UPDATE SET attempts = attempts + 1, successes = successes + ?, failures = failures + ?, empty_results = empty_results + ?, total_results = total_results + ?, success_duration_ms = success_duration_ms + ?, failure_duration_ms = failure_duration_ms + ?`,
      [
        keyId, engineId, hour,
        successInc, failureInc, emptyInc, attempt.resultCount, successDur, failureDur,
        successInc, failureInc, emptyInc, attempt.resultCount, successDur, failureDur,
      ],
    )
  }

  async query(opts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string }): Promise<WebSearchEngineUsageRecord[]> {
    const { sql, binds } = buildKeyIdRangeQuery("web_search_engine_usage", WS_ENGINE_COLS, opts)
    const rows = await this.x.all<any>(sql, binds)
    return rows.map((r) => ({
      keyId: r.key_id as ApiKeyId, engineId: r.engine_id, hour: r.hour,
      attempts: r.attempts, successes: r.successes, failures: r.failures,
      emptyResults: r.empty_results, totalResults: r.total_results,
      successDurationMs: r.success_duration_ms, failureDurationMs: r.failure_duration_ms,
    }))
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM web_search_engine_usage", [])
  }
}

class SharedKeyAssignmentRepo implements KeyAssignmentRepo {
  constructor(private x: SqlExecutor) {}

  async assign(keyId: ApiKeyId, userId: UserId, assignedBy: UserId): Promise<void> {
    await this.x.run(`INSERT OR REPLACE INTO key_assignments (${KEY_ASSIGN_COLS}) VALUES (?, ?, ?, ?)`, [keyId, userId, assignedBy, new Date().toISOString()])
  }

  async unassign(keyId: ApiKeyId, userId: UserId): Promise<void> {
    await this.x.run("DELETE FROM key_assignments WHERE key_id = ? AND user_id = ?", [keyId, userId])
  }

  async listByUser(userId: UserId): Promise<KeyAssignment[]> {
    const rows = await this.x.all<any>(`SELECT ${KEY_ASSIGN_COLS} FROM key_assignments WHERE user_id = ?`, [userId])
    return rows.map((r) => ({ keyId: r.key_id as ApiKeyId, userId: r.user_id as UserId, assignedBy: r.assigned_by as UserId, assignedAt: r.assigned_at }))
  }

  async listByKey(keyId: ApiKeyId): Promise<KeyAssignment[]> {
    const rows = await this.x.all<any>(`SELECT ${KEY_ASSIGN_COLS} FROM key_assignments WHERE key_id = ?`, [keyId])
    return rows.map((r) => ({ keyId: r.key_id as ApiKeyId, userId: r.user_id as UserId, assignedBy: r.assigned_by as UserId, assignedAt: r.assigned_at }))
  }

  async deleteByKey(keyId: ApiKeyId): Promise<void> {
    await this.x.run("DELETE FROM key_assignments WHERE key_id = ?", [keyId])
  }

  async deleteByUser(userId: UserId): Promise<void> {
    await this.x.run("DELETE FROM key_assignments WHERE user_id = ?", [userId])
  }
}

class SharedObservabilityShareRepo implements ObservabilityShareRepo {
  constructor(private x: SqlExecutor) {}

  async share(ownerId: UserId, viewerId: UserId, grantedBy: UserId): Promise<void> {
    await this.x.run(`INSERT OR REPLACE INTO observability_shares (${SHARE_COLS}) VALUES (?, ?, ?, ?)`, [ownerId, viewerId, grantedBy, new Date().toISOString()])
  }

  async unshare(ownerId: UserId, viewerId: UserId): Promise<void> {
    await this.x.run("DELETE FROM observability_shares WHERE owner_id = ? AND viewer_id = ?", [ownerId, viewerId])
  }

  async listByOwner(ownerId: UserId): Promise<ObservabilityShare[]> {
    const rows = await this.x.all<any>(`SELECT ${SHARE_COLS} FROM observability_shares WHERE owner_id = ?`, [ownerId])
    return rows.map((r) => ({ ownerId: r.owner_id as UserId, viewerId: r.viewer_id as UserId, grantedBy: r.granted_by as UserId, grantedAt: r.granted_at }))
  }

  async listByViewer(viewerId: UserId): Promise<ObservabilityShare[]> {
    const rows = await this.x.all<any>(`SELECT ${SHARE_COLS} FROM observability_shares WHERE viewer_id = ?`, [viewerId])
    return rows.map((r) => ({ ownerId: r.owner_id as UserId, viewerId: r.viewer_id as UserId, grantedBy: r.granted_by as UserId, grantedAt: r.granted_at }))
  }

  async isGranted(ownerId: UserId, viewerId: UserId): Promise<boolean> {
    const row = await this.x.first("SELECT 1 AS one FROM observability_shares WHERE owner_id = ? AND viewer_id = ? LIMIT 1", [ownerId, viewerId])
    return !!row
  }

  async deleteByOwner(ownerId: UserId): Promise<void> {
    await this.x.run("DELETE FROM observability_shares WHERE owner_id = ?", [ownerId])
  }

  async deleteByViewer(viewerId: UserId): Promise<void> {
    await this.x.run("DELETE FROM observability_shares WHERE viewer_id = ?", [viewerId])
  }
}

class SharedDeviceCodeRepo implements DeviceCodeRepo {
  constructor(private x: SqlExecutor) {}

  async create(code: DeviceCode): Promise<void> {
    await this.x.run(`INSERT INTO device_codes (${DEVICE_COLS}) VALUES (?, ?, ?, ?, ?, ?)`, [code.deviceCode, code.userCode, code.expiresAt, code.userId ?? null, code.sessionToken ?? null, code.createdAt])
  }

  async findByDeviceCode(deviceCode: DeviceCodeToken): Promise<DeviceCode | null> {
    const row = await this.x.first(`SELECT ${DEVICE_COLS} FROM device_codes WHERE device_code = ?`, [deviceCode])
    return row ? toDeviceCode(row) : null
  }

  async findByUserCode(userCode: string): Promise<DeviceCode | null> {
    const row = await this.x.first(`SELECT ${DEVICE_COLS} FROM device_codes WHERE user_code = ?`, [userCode])
    return row ? toDeviceCode(row) : null
  }

  async verify(deviceCode: DeviceCodeToken, userId: UserId, sessionToken: SessionToken): Promise<void> {
    await this.x.run("UPDATE device_codes SET user_id = ?, session_token = ? WHERE device_code = ?", [userId, sessionToken, deviceCode])
  }

  async deleteExpired(): Promise<void> {
    await this.x.run("DELETE FROM device_codes WHERE expires_at < ?", [new Date().toISOString()])
  }

  async delete(deviceCode: DeviceCodeToken): Promise<void> {
    await this.x.run("DELETE FROM device_codes WHERE device_code = ?", [deviceCode])
  }
}

function toPerformanceSummaryRecord(r: any): PerformanceSummaryRecord {
  return {
    hour: r.hour,
    metricScope: r.metric_scope,
    keyId: r.key_id as ApiKeyId,
    model: r.model,
    upstream: r.upstream ?? null,
    sourceApi: r.source_api,
    targetApi: r.target_api,
    stream: r.stream === 1,
    runtimeLocation: r.runtime_location,
    operation: r.operation ?? null,
    requests: r.requests,
    errors: r.errors,
    totalMsSum: r.total_ms_sum,
  }
}

function toPerformanceBucketRecord(r: any): PerformanceBucketRecord {
  return {
    hour: r.hour,
    metricScope: r.metric_scope,
    keyId: r.key_id as ApiKeyId,
    model: r.model,
    upstream: r.upstream ?? null,
    sourceApi: r.source_api,
    targetApi: r.target_api,
    stream: r.stream === 1,
    runtimeLocation: r.runtime_location,
    operation: r.operation ?? null,
    lowerMs: r.lower_ms,
    upperMs: r.upper_ms,
    count: r.count,
  }
}

class SharedPerformanceRepo implements PerformanceRepo {
  constructor(private x: SqlExecutor) {}

  async record(entry: PerformanceRecordInput): Promise<void> {
    const streamInt = entry.stream ? 1 : 0
    const errorInt = entry.isError ? 1 : 0
    const durationMs = Math.max(0, Math.round(entry.durationMs))
    const upstream = entry.upstream ?? null
    const operation = entry.operation ?? null
    await this.x.run(
      `INSERT INTO performance_summary (${PERF_SUMMARY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (hour, metric_scope, key_id, model, COALESCE(upstream, ''), source_api, target_api, stream, runtime_location, COALESCE(operation, ''))
       DO UPDATE SET requests = requests + 1, errors = errors + excluded.errors, total_ms_sum = total_ms_sum + excluded.total_ms_sum`,
      [
        entry.hour, entry.metricScope, entry.keyId, entry.model, upstream,
        entry.sourceApi, entry.targetApi, streamInt, entry.runtimeLocation,
        operation,
        errorInt, durationMs,
      ],
    )

    const { lowerMs, upperMs } = latencyBucketForMs(durationMs)
    await this.x.run(
      `INSERT INTO performance_latency_buckets (${PERF_BUCKET_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (hour, metric_scope, key_id, model, COALESCE(upstream, ''), source_api, target_api, stream, runtime_location, COALESCE(operation, ''), lower_ms, upper_ms)
       DO UPDATE SET count = count + 1`,
      [
        entry.hour, entry.metricScope, entry.keyId, entry.model, upstream,
        entry.sourceApi, entry.targetApi, streamInt, entry.runtimeLocation,
        operation,
        lowerMs, upperMs,
      ],
    )
  }

  async query(opts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string; metricScope?: PerformanceMetricScope }): Promise<{ summary: PerformanceSummaryRecord[]; buckets: PerformanceBucketRecord[] }> {
    const summary = await this.queryTable("performance_summary", PERF_SUMMARY_COLS, opts)
    const buckets = await this.queryTable("performance_latency_buckets", PERF_BUCKET_COLS, opts)
    return {
      summary: summary.map(toPerformanceSummaryRecord),
      buckets: buckets.map(toPerformanceBucketRecord),
    }
  }

  private async queryTable(table: string, cols: string, opts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string; metricScope?: PerformanceMetricScope }): Promise<any[]> {
    const { sql, binds } = buildKeyIdRangeQuery(table, cols, opts)
    if (!opts.metricScope) return this.x.all(sql, binds)
    const scopedSql = sql.replace("ORDER BY hour", "AND metric_scope = ? ORDER BY hour")
    return this.x.all(scopedSql, [...binds, opts.metricScope])
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM performance_summary", [])
    await this.x.run("DELETE FROM performance_latency_buckets", [])
  }
}

export function buildSharedRepo(x: SqlExecutor): Repo {
  return {
    apiKeys: new SharedApiKeyRepo(x),
    github: new SharedGitHubRepo(x),
    upstreams: new SharedUpstreamRepo(x),
    usage: new SharedUsageRepo(x),
    cache: new SharedCacheRepo(x),
    latency: new SharedLatencyRepo(x),
    performance: new SharedPerformanceRepo(x),
    users: new SharedUserRepo(x),
    inviteCodes: new SharedInviteCodeRepo(x),
    sessions: new SharedSessionRepo(x),
    presence: new SharedClientPresenceRepo(x),
    webSearchUsage: new SharedWebSearchUsageRepo(x),
    webSearchEngineUsage: new SharedWebSearchEngineUsageRepo(x),
    keyAssignments: new SharedKeyAssignmentRepo(x),
    deviceCodes: new SharedDeviceCodeRepo(x),
    observabilityShares: new SharedObservabilityShareRepo(x),
    responsesItems: new SharedResponsesItemsRepo(x),
    proxies: new SharedProxyRepo(x),
    proxyBackoffs: new SharedProxyBackoffRepo(x),
  }
}

function toResponsesItemRecord(r: any): ResponsesItemRecord {
  return {
    id: r.id as ResponsesItemId,
    apiKeyId: r.api_key_id ? (r.api_key_id as ApiKeyId) : null,
    kind: r.kind,
    itemJson: r.item_json,
    privateJson: r.private_json ?? null,
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? null,
  }
}

class SharedResponsesItemsRepo implements ResponsesItemsRepo {
  constructor(private x: SqlExecutor) {}

  async insertMany(records: ResponsesItemRecord[]): Promise<void> {
    if (records.length === 0) return
    for (const r of records) {
      await this.x.run(
        `INSERT INTO responses_items (${RESPONSES_ITEMS_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           api_key_id = excluded.api_key_id,
           kind = excluded.kind,
           item_json = excluded.item_json,
           private_json = excluded.private_json,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
        [r.id, r.apiKeyId, r.kind, r.itemJson, r.privateJson, r.createdAt, r.expiresAt],
      )
    }
  }

  async lookupMany(ids: ResponsesItemId[], apiKeyId?: ApiKeyId): Promise<ResponsesItemRecord[]> {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => "?").join(", ")
    const where = apiKeyId !== undefined ? ` AND api_key_id = ?` : ""
    const params: Array<string | number | null> = [...ids]
    if (apiKeyId !== undefined) params.push(apiKeyId)
    const rows = await this.x.all(
      `SELECT ${RESPONSES_ITEMS_COLS} FROM responses_items WHERE id IN (${placeholders})${where}`,
      params,
    )
    return rows.map(toResponsesItemRecord)
  }

  async deleteExpired(now: string): Promise<void> {
    await this.x.run("DELETE FROM responses_items WHERE expires_at IS NOT NULL AND expires_at < ?", [now])
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM responses_items", [])
  }
}

const PROXY_COLS = "id, name, url, created_at, updated_at, dial_timeout_seconds"

interface ProxyRow {
  id: string
  name: string
  url: string
  created_at: string
  updated_at: string
  dial_timeout_seconds: number | null
}

const toProxyRecord = (row: ProxyRow): ProxyRecord => ({
  id: row.id,
  name: row.name,
  url: row.url,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  dialTimeoutSeconds: row.dial_timeout_seconds,
})

class SharedProxyRepo implements ProxyRepo {
  constructor(private x: SqlExecutor) {}

  async list(): Promise<ProxyRecord[]> {
    const rows = await this.x.all<ProxyRow>(
      `SELECT ${PROXY_COLS} FROM proxies ORDER BY created_at`,
      [],
    )
    return rows.map(toProxyRecord)
  }

  async getById(id: string): Promise<ProxyRecord | null> {
    const row = await this.x.first<ProxyRow>(
      `SELECT ${PROXY_COLS} FROM proxies WHERE id = ?`,
      [id],
    )
    return row ? toProxyRecord(row) : null
  }

  async insert(input: {
    id: string
    name: string
    url: string
    dialTimeoutSeconds: number | null
  }): Promise<ProxyRecord> {
    const now = new Date().toISOString()
    await this.x.run(
      `INSERT INTO proxies (${PROXY_COLS}) VALUES (?, ?, ?, ?, ?, ?)`,
      [input.id, input.name, input.url, now, now, input.dialTimeoutSeconds],
    )
    return {
      id: input.id,
      name: input.name,
      url: input.url,
      createdAt: now,
      updatedAt: now,
      dialTimeoutSeconds: input.dialTimeoutSeconds,
    }
  }

  async patch(
    id: string,
    patch: { name?: string; url?: string; dialTimeoutSeconds?: number | null },
  ): Promise<{ record: ProxyRecord; urlChanged: boolean } | null> {
    const existing = await this.getById(id)
    if (!existing) return null

    const nextName = patch.name ?? existing.name
    const nextUrl = patch.url ?? existing.url
    // dialTimeoutSeconds is nullable, so distinguish "not in patch" from
    // "set to null" by hasOwn — `??` would collapse a deliberate clear.
    const nextDialTimeout = Object.hasOwn(patch, "dialTimeoutSeconds")
      ? patch.dialTimeoutSeconds!
      : existing.dialTimeoutSeconds
    const urlChanged = patch.url !== undefined && patch.url !== existing.url
    const updatedAt = new Date().toISOString()

    await this.x.run(
      "UPDATE proxies SET name = ?, url = ?, dial_timeout_seconds = ?, updated_at = ? WHERE id = ?",
      [nextName, nextUrl, nextDialTimeout, updatedAt, id],
    )

    return {
      record: {
        ...existing,
        name: nextName,
        url: nextUrl,
        dialTimeoutSeconds: nextDialTimeout,
        updatedAt,
      },
      urlChanged,
    }
  }

  async save(record: {
    id: string
    name: string
    url: string
    dialTimeoutSeconds: number | null
  }): Promise<void> {
    const now = new Date().toISOString()
    await this.x.run(
      `INSERT INTO proxies (${PROXY_COLS}) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         url = excluded.url,
         updated_at = excluded.updated_at,
         dial_timeout_seconds = excluded.dial_timeout_seconds`,
      [record.id, record.name, record.url, now, now, record.dialTimeoutSeconds],
    )
  }

  async delete(id: string): Promise<boolean> {
    // Conditional delete: refuse to drop a row currently referenced by any
    // upstream's fallback list. Folding the predicate into the DELETE closes
    // the TOCTOU window where an admin PATCHes an upstream to add the
    // reference between findUpstreamsReferencing and this DELETE.
    const r = await this.x.run(
      `DELETE FROM proxies
       WHERE id = ?
         AND NOT EXISTS (
           SELECT 1 FROM upstreams u, json_each(u.proxy_fallback_list_json) j
           WHERE json_extract(j.value, '$.id') = proxies.id
         )`,
      [id],
    )
    return r.changes > 0
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM proxies", [])
  }

  async findUpstreamsReferencing(proxyId: string): Promise<string[]> {
    const rows = await this.x.all<{ id: string }>(
      "SELECT DISTINCT u.id FROM upstreams u, json_each(u.proxy_fallback_list_json) j WHERE json_extract(j.value, '$.id') = ?",
      [proxyId],
    )
    return rows.map((r) => r.id)
  }
}

interface BackoffRowDb {
  proxy_id: string
  upstream_id: string
  fail_count: number
  expires_at: number
  last_error: string | null
  last_error_at: number | null
}

const toBackoffRow = (row: BackoffRowDb): BackoffRow => ({
  proxyId: row.proxy_id,
  upstreamId: row.upstream_id,
  failCount: row.fail_count,
  expiresAt: row.expires_at,
  lastError: row.last_error,
  lastErrorAt: row.last_error_at,
})

class SharedProxyBackoffRepo implements ProxyBackoffRepo {
  constructor(private x: SqlExecutor) {}

  async recordDialFailure(proxyId: string, upstreamId: string, errorMessage: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    // SQLite reads RHS column references at the start of the UPDATE, before
    // the increment is applied. So `1 << fail_count` resolves against the
    // pre-increment value, yielding 60 * 2^(n-1) on the n-th failure. The
    // exponent is clamped at 6 because larger values already saturate at
    // the 3600s cap; capping keeps the shift bounded regardless of how
    // long a runaway proxy has been failing.
    await this.x.run(
      `INSERT INTO proxy_upstream_backoffs
         (proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at)
       VALUES (?, ?, 1, ? + 60, ?, ?)
       ON CONFLICT (proxy_id, upstream_id) DO UPDATE SET
         fail_count = fail_count + 1,
         expires_at = ? + min(60 * (1 << min(fail_count, 6)), 3600),
         last_error = excluded.last_error,
         last_error_at = excluded.last_error_at`,
      [proxyId, upstreamId, now, errorMessage, now, now],
    )
  }

  async recordDialSuccess(proxyId: string, upstreamId: string): Promise<void> {
    await this.x.run(
      "DELETE FROM proxy_upstream_backoffs WHERE proxy_id = ? AND upstream_id = ?",
      [proxyId, upstreamId],
    )
  }

  async listForUpstream(upstreamId: string): Promise<BackoffRow[]> {
    const rows = await this.x.all<BackoffRowDb>(
      "SELECT proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at FROM proxy_upstream_backoffs WHERE upstream_id = ?",
      [upstreamId],
    )
    return rows.map(toBackoffRow)
  }

  async listForProxy(proxyId: string): Promise<BackoffRow[]> {
    const rows = await this.x.all<BackoffRowDb>(
      "SELECT proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at FROM proxy_upstream_backoffs WHERE proxy_id = ?",
      [proxyId],
    )
    return rows.map(toBackoffRow)
  }

  async listAll(): Promise<BackoffRow[]> {
    const rows = await this.x.all<BackoffRowDb>(
      "SELECT proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at FROM proxy_upstream_backoffs",
      [],
    )
    return rows.map(toBackoffRow)
  }

  async resetForProxy(proxyId: string): Promise<void> {
    await this.x.run("DELETE FROM proxy_upstream_backoffs WHERE proxy_id = ?", [proxyId])
  }

  async resetForUpstream(upstreamId: string): Promise<void> {
    await this.x.run("DELETE FROM proxy_upstream_backoffs WHERE upstream_id = ?", [upstreamId])
  }

  async reset(proxyId: string, upstreamId: string): Promise<void> {
    await this.x.run(
      "DELETE FROM proxy_upstream_backoffs WHERE proxy_id = ? AND upstream_id = ?",
      [proxyId, upstreamId],
    )
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM proxy_upstream_backoffs", [])
  }
}
