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
import { latencyBucketForMs } from "~/lib/performance-histogram"
import type { SqlExecutor } from "./executor"

const API_KEY_COLS = "id, name, key, created_at, last_used_at, owner_id, quota_requests_per_day, quota_tokens_per_day, web_search_enabled, web_search_langsearch_key, web_search_tavily_key, web_search_ms_grounding_key, web_search_priority, web_search_langsearch_ref, web_search_tavily_ref, web_search_ms_grounding_ref"
const GITHUB_COLS = "user_id, token, account_type, login, name, avatar_url, owner_id, enabled, sort_order, flag_overrides, updated_at"
const UPSTREAM_COLS = "id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, created_at, updated_at"
const USAGE_COLS = "key_id, model, upstream, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_json"
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
const PERF_SUMMARY_COLS = "hour, metric_scope, key_id, model, upstream, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum"
const PERF_BUCKET_COLS = "hour, metric_scope, key_id, model, upstream, source_api, target_api, stream, runtime_location, lower_ms, upper_ms, count"
const RESPONSES_ITEMS_COLS = "id, api_key_id, kind, item_json, private_json, created_at, expires_at"

function toApiKey(row: any): ApiKey {
  let priority: string[] | undefined
  if (typeof row.web_search_priority === "string" && row.web_search_priority.length > 0) {
    try {
      const parsed = JSON.parse(row.web_search_priority)
      if (Array.isArray(parsed)) priority = parsed.filter((v: unknown): v is string => typeof v === "string")
    } catch {}
  }
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    ownerId: row.owner_id ?? undefined,
    quotaRequestsPerDay: row.quota_requests_per_day ?? undefined,
    quotaTokensPerDay: row.quota_tokens_per_day ?? undefined,
    webSearchEnabled: row.web_search_enabled === 1,
    webSearchLangsearchKey: row.web_search_langsearch_key ?? undefined,
    webSearchTavilyKey: row.web_search_tavily_key ?? undefined,
    webSearchMsGroundingKey: row.web_search_ms_grounding_key ?? undefined,
    webSearchPriority: priority,
    webSearchLangsearchRef: row.web_search_langsearch_ref ?? undefined,
    webSearchTavilyRef: row.web_search_tavily_ref ?? undefined,
    webSearchMsGroundingRef: row.web_search_ms_grounding_ref ?? undefined,
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
    ownerId: row.owner_id ?? undefined,
    user: { id: row.user_id, login: row.login, name: row.name, avatar_url: row.avatar_url },
    enabled: row.enabled === undefined ? undefined : row.enabled === 1,
    sortOrder: row.sort_order ?? undefined,
    flagOverrides,
    updatedAt: row.updated_at ?? undefined,
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

function toUpstreamRecord(row: any): UpstreamRecord {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toUsageRecord(r: any): UsageRecord {
  return {
    keyId: r.key_id,
    model: r.model,
    hour: r.hour,
    client: r.client || "",
    upstream: r.upstream ?? null,
    requests: r.requests,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens ?? 0,
    cacheCreationTokens: r.cache_creation_tokens ?? 0,
    costJson: r.cost_json ?? null,
  }
}

function toLatencyRecord(r: any): LatencyRecord {
  return {
    keyId: r.key_id,
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
    id: row.id,
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
    id: row.id,
    code: row.code,
    name: row.name,
    email: row.email ?? undefined,
    createdAt: row.created_at,
    usedAt: row.used_at ?? undefined,
    usedBy: row.used_by ?? undefined,
  }
}

function toPresence(row: any): ClientPresence {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    keyId: row.key_id ?? null,
    keyName: row.key_name ?? null,
    ownerId: row.owner_id ?? null,
    gatewayUrl: row.gateway_url ?? null,
    lastSeenAt: row.last_seen_at,
  }
}

function toDeviceCode(row: any): DeviceCode {
  return {
    deviceCode: row.device_code,
    userCode: row.user_code,
    expiresAt: row.expires_at,
    userId: row.user_id ?? undefined,
    sessionToken: row.session_token ?? undefined,
    createdAt: row.created_at,
  }
}

// Build the WHERE clause + binds for the keyIds / keyId / none branch shared
// by usage.query, latency.query, web_search_usage.query, web_search_engine_usage.query.
function buildKeyIdRangeQuery(table: string, cols: string, opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): { sql: string; binds: unknown[] } {
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

  async listByOwner(ownerId: string): Promise<ApiKey[]> {
    return (await this.x.all(`SELECT ${API_KEY_COLS} FROM api_keys WHERE owner_id = ? ORDER BY created_at`, [ownerId])).map(toApiKey)
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const row = await this.x.first(`SELECT ${API_KEY_COLS} FROM api_keys WHERE key = ?`, [rawKey])
    return row ? toApiKey(row) : null
  }

  async getById(id: string): Promise<ApiKey | null> {
    const row = await this.x.first(`SELECT ${API_KEY_COLS} FROM api_keys WHERE id = ?`, [id])
    return row ? toApiKey(row) : null
  }

  async save(key: ApiKey): Promise<void> {
    await this.x.run(
      `INSERT INTO api_keys (${API_KEY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, key = excluded.key, last_used_at = excluded.last_used_at, owner_id = excluded.owner_id, quota_requests_per_day = excluded.quota_requests_per_day, quota_tokens_per_day = excluded.quota_tokens_per_day, web_search_enabled = excluded.web_search_enabled, web_search_langsearch_key = excluded.web_search_langsearch_key, web_search_tavily_key = excluded.web_search_tavily_key, web_search_ms_grounding_key = excluded.web_search_ms_grounding_key, web_search_priority = excluded.web_search_priority, web_search_langsearch_ref = excluded.web_search_langsearch_ref, web_search_tavily_ref = excluded.web_search_tavily_ref, web_search_ms_grounding_ref = excluded.web_search_ms_grounding_ref`,
      [
        key.id, key.name, key.key, key.createdAt, key.lastUsedAt ?? null, key.ownerId ?? null,
        key.quotaRequestsPerDay ?? null, key.quotaTokensPerDay ?? null,
        key.webSearchEnabled ? 1 : 0,
        key.webSearchLangsearchKey ?? null, key.webSearchTavilyKey ?? null, key.webSearchMsGroundingKey ?? null,
        key.webSearchPriority ? JSON.stringify(key.webSearchPriority) : null,
        key.webSearchLangsearchRef ?? null, key.webSearchTavilyRef ?? null, key.webSearchMsGroundingRef ?? null,
      ],
    )
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.x.run("DELETE FROM api_keys WHERE id = ?", [id])
    return r.changes > 0
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM api_keys", [])
  }
}

class SharedGitHubRepo implements GitHubRepo {
  constructor(private x: SqlExecutor) {}

  async listAccounts(): Promise<GitHubAccount[]> {
    return (await this.x.all(`SELECT ${GITHUB_COLS} FROM github_accounts`, [])).map(toGitHubAccount)
  }

  async listAccountsByOwner(ownerId: string): Promise<GitHubAccount[]> {
    return (await this.x.all(`SELECT ${GITHUB_COLS} FROM github_accounts WHERE owner_id = ?`, [ownerId])).map(toGitHubAccount)
  }

  async getAccount(userId: number, ownerId?: string): Promise<GitHubAccount | null> {
    const row = await this.x.first(`SELECT ${GITHUB_COLS} FROM github_accounts WHERE user_id = ? AND owner_id = ?`, [userId, ownerId ?? ""])
    return row ? toGitHubAccount(row) : null
  }

  async saveAccount(userId: number, account: GitHubAccount): Promise<void> {
    const flagOverridesJson = account.flagOverrides ? JSON.stringify(account.flagOverrides) : "{}"
    const updatedAt = account.updatedAt ?? new Date().toISOString()
    await this.x.run(
      `INSERT INTO github_accounts (${GITHUB_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, owner_id) DO UPDATE SET token = excluded.token, account_type = excluded.account_type, login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url, enabled = excluded.enabled, sort_order = excluded.sort_order, flag_overrides = excluded.flag_overrides, updated_at = excluded.updated_at`,
      [
        userId, account.token, account.accountType, account.user.login, account.user.name, account.user.avatar_url, account.ownerId ?? "",
        account.enabled === false ? 0 : 1,
        account.sortOrder ?? 0,
        flagOverridesJson,
        updatedAt,
      ],
    )
  }

  async deleteAccount(userId: number, ownerId?: string): Promise<void> {
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

  async getActiveId(): Promise<number | null> {
    const row = await this.x.first<{ value: string }>("SELECT value FROM config WHERE key = ?", ["active_github_account"])
    return row ? Number(row.value) : null
  }

  async setActiveId(userId: number): Promise<void> {
    await this.x.run("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", ["active_github_account", String(userId)])
  }

  async clearActiveId(): Promise<void> {
    await this.x.run("DELETE FROM config WHERE key = ?", ["active_github_account"])
  }

  async getActiveIdForUser(ownerId: string): Promise<number | null> {
    const row = await this.x.first<{ value: string }>("SELECT value FROM config WHERE key = ?", [`active_github_account:${ownerId}`])
    return row ? Number(row.value) : null
  }

  async setActiveIdForUser(ownerId: string, userId: number): Promise<void> {
    await this.x.run("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [`active_github_account:${ownerId}`, String(userId)])
  }

  async clearActiveIdForUser(ownerId: string): Promise<void> {
    await this.x.run("DELETE FROM config WHERE key = ?", [`active_github_account:${ownerId}`])
  }
}

class SharedUpstreamRepo implements UpstreamRepo {
  constructor(private x: SqlExecutor) {}

  async list(opts: { ownerId?: string; includeDisabled?: boolean } = {}): Promise<UpstreamRecord[]> {
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

  async getById(id: string): Promise<UpstreamRecord | null> {
    const row = await this.x.first(`SELECT ${UPSTREAM_COLS} FROM upstreams WHERE id = ?`, [id])
    return row ? toUpstreamRecord(row) : null
  }

  async save(upstream: UpstreamRecord): Promise<void> {
    await this.x.run(
      `INSERT INTO upstreams (${UPSTREAM_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, provider = excluded.provider, name = excluded.name, enabled = excluded.enabled, sort_order = excluded.sort_order, config_json = excluded.config_json, flag_overrides = excluded.flag_overrides, disabled_public_model_ids = excluded.disabled_public_model_ids, updated_at = excluded.updated_at`,
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
        upstream.createdAt,
        upstream.updatedAt,
      ],
    )
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.x.run("DELETE FROM upstreams WHERE id = ?", [id])
    return r.changes > 0
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM upstreams", [])
  }
}

class SharedUsageRepo implements UsageRepo {
  constructor(private x: SqlExecutor) {}

  async record(keyId: string, model: string, hour: string, requests: number, inputTokens: number, outputTokens: number, client?: string, cacheReadTokens?: number, cacheCreationTokens?: number, upstream?: string | null, costJson?: string | null): Promise<void> {
    await this.x.run(
      `INSERT INTO usage (${USAGE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_id, model, COALESCE(upstream, ''), hour, client) DO UPDATE SET requests = requests + excluded.requests, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens, cost_json = COALESCE(excluded.cost_json, cost_json)`,
      [keyId, model, upstream ?? null, hour, client || "", requests, inputTokens, outputTokens, cacheReadTokens ?? 0, cacheCreationTokens ?? 0, costJson ?? null],
    )
  }

  async query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<UsageRecord[]> {
    const { sql, binds } = buildKeyIdRangeQuery("usage", USAGE_COLS, opts)
    return (await this.x.all(sql, binds)).map(toUsageRecord)
  }

  async listAll(): Promise<UsageRecord[]> {
    return (await this.x.all(`SELECT ${USAGE_COLS} FROM usage ORDER BY hour`, [])).map(toUsageRecord)
  }

  async set(record: UsageRecord): Promise<void> {
    await this.x.run(
      `INSERT INTO usage (${USAGE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_id, model, COALESCE(upstream, ''), hour, client) DO UPDATE SET requests = excluded.requests, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens, cache_creation_tokens = excluded.cache_creation_tokens, cost_json = excluded.cost_json`,
      [record.keyId, record.model, record.upstream ?? null, record.hour, record.client || "", record.requests, record.inputTokens, record.outputTokens, record.cacheReadTokens ?? 0, record.cacheCreationTokens ?? 0, record.costJson ?? null],
    )
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM usage", [])
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

  async record(entry: { keyId: string; model: string; hour: string; colo: string; stream: boolean; totalMs: number; upstreamMs: number; ttfbMs: number; tokenMiss: boolean }): Promise<void> {
    await this.x.run(
      `INSERT INTO latency (${LATENCY_COLS}) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT (key_id, model, hour, colo, stream) DO UPDATE SET requests = requests + 1, total_ms = total_ms + excluded.total_ms, upstream_ms = upstream_ms + excluded.upstream_ms, ttfb_ms = ttfb_ms + excluded.ttfb_ms, token_miss = token_miss + excluded.token_miss`,
      [entry.keyId, entry.model, entry.hour, entry.colo, entry.stream ? 1 : 0, entry.totalMs, entry.upstreamMs, entry.ttfbMs, entry.tokenMiss ? 1 : 0],
    )
  }

  async query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<LatencyRecord[]> {
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

  async getById(id: string): Promise<User | null> {
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

  async update(id: string, fields: Partial<Pick<User, "name" | "email" | "avatarUrl" | "disabled" | "lastLoginAt" | "userKey" | "passwordHash">>): Promise<void> {
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

  async delete(id: string): Promise<void> {
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

  async markUsed(id: string, userId: string): Promise<void> {
    await this.x.run("UPDATE invite_codes SET used_at = ?, used_by = ? WHERE id = ?", [new Date().toISOString(), userId, id])
  }

  async clearUsedBy(userId: string): Promise<void> {
    await this.x.run("UPDATE invite_codes SET used_by = NULL WHERE used_by = ?", [userId])
  }

  async delete(id: string): Promise<void> {
    await this.x.run("DELETE FROM invite_codes WHERE id = ?", [id])
  }
}

class SharedSessionRepo implements SessionRepo {
  constructor(private x: SqlExecutor) {}

  async create(session: UserSession): Promise<void> {
    await this.x.run(`INSERT INTO user_sessions (${SESSION_COLS}) VALUES (?, ?, ?, ?)`, [session.token, session.userId, session.createdAt, session.expiresAt])
  }

  async findByToken(token: string): Promise<UserSession | null> {
    const row = await this.x.first<any>(`SELECT ${SESSION_COLS} FROM user_sessions WHERE token = ?`, [token])
    return row ? { token: row.token, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at } : null
  }

  async deleteByUserId(userId: string): Promise<void> {
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

  async listByOwner(ownerId: string): Promise<ClientPresence[]> {
    return (await this.x.all(`SELECT ${PRESENCE_COLS} FROM client_presence WHERE owner_id = ? ORDER BY last_seen_at DESC`, [ownerId])).map(toPresence)
  }

  async listByKeyIds(keyIds: string[]): Promise<ClientPresence[]> {
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

  async record(keyId: string, hour: string, success: boolean): Promise<void> {
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

  async query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<WebSearchUsageRecord[]> {
    const { sql, binds } = buildKeyIdRangeQuery("web_search_usage", WS_USAGE_COLS, opts)
    const rows = await this.x.all<any>(sql, binds)
    return rows.map((r) => ({ keyId: r.key_id, hour: r.hour, searches: r.searches, successes: r.successes, failures: r.failures }))
  }

  async deleteAll(): Promise<void> {
    await this.x.run("DELETE FROM web_search_usage", [])
  }
}

class SharedWebSearchEngineUsageRepo implements WebSearchEngineUsageRepo {
  constructor(private x: SqlExecutor) {}

  async record(keyId: string, engineId: string, hour: string, attempt: { ok: boolean; resultCount: number; durationMs: number }): Promise<void> {
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

  async query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<WebSearchEngineUsageRecord[]> {
    const { sql, binds } = buildKeyIdRangeQuery("web_search_engine_usage", WS_ENGINE_COLS, opts)
    const rows = await this.x.all<any>(sql, binds)
    return rows.map((r) => ({
      keyId: r.key_id, engineId: r.engine_id, hour: r.hour,
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

  async assign(keyId: string, userId: string, assignedBy: string): Promise<void> {
    await this.x.run(`INSERT OR REPLACE INTO key_assignments (${KEY_ASSIGN_COLS}) VALUES (?, ?, ?, ?)`, [keyId, userId, assignedBy, new Date().toISOString()])
  }

  async unassign(keyId: string, userId: string): Promise<void> {
    await this.x.run("DELETE FROM key_assignments WHERE key_id = ? AND user_id = ?", [keyId, userId])
  }

  async listByUser(userId: string): Promise<KeyAssignment[]> {
    const rows = await this.x.all<any>(`SELECT ${KEY_ASSIGN_COLS} FROM key_assignments WHERE user_id = ?`, [userId])
    return rows.map((r) => ({ keyId: r.key_id, userId: r.user_id, assignedBy: r.assigned_by, assignedAt: r.assigned_at }))
  }

  async listByKey(keyId: string): Promise<KeyAssignment[]> {
    const rows = await this.x.all<any>(`SELECT ${KEY_ASSIGN_COLS} FROM key_assignments WHERE key_id = ?`, [keyId])
    return rows.map((r) => ({ keyId: r.key_id, userId: r.user_id, assignedBy: r.assigned_by, assignedAt: r.assigned_at }))
  }

  async deleteByKey(keyId: string): Promise<void> {
    await this.x.run("DELETE FROM key_assignments WHERE key_id = ?", [keyId])
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.x.run("DELETE FROM key_assignments WHERE user_id = ?", [userId])
  }
}

class SharedObservabilityShareRepo implements ObservabilityShareRepo {
  constructor(private x: SqlExecutor) {}

  async share(ownerId: string, viewerId: string, grantedBy: string): Promise<void> {
    await this.x.run(`INSERT OR REPLACE INTO observability_shares (${SHARE_COLS}) VALUES (?, ?, ?, ?)`, [ownerId, viewerId, grantedBy, new Date().toISOString()])
  }

  async unshare(ownerId: string, viewerId: string): Promise<void> {
    await this.x.run("DELETE FROM observability_shares WHERE owner_id = ? AND viewer_id = ?", [ownerId, viewerId])
  }

  async listByOwner(ownerId: string): Promise<ObservabilityShare[]> {
    const rows = await this.x.all<any>(`SELECT ${SHARE_COLS} FROM observability_shares WHERE owner_id = ?`, [ownerId])
    return rows.map((r) => ({ ownerId: r.owner_id, viewerId: r.viewer_id, grantedBy: r.granted_by, grantedAt: r.granted_at }))
  }

  async listByViewer(viewerId: string): Promise<ObservabilityShare[]> {
    const rows = await this.x.all<any>(`SELECT ${SHARE_COLS} FROM observability_shares WHERE viewer_id = ?`, [viewerId])
    return rows.map((r) => ({ ownerId: r.owner_id, viewerId: r.viewer_id, grantedBy: r.granted_by, grantedAt: r.granted_at }))
  }

  async isGranted(ownerId: string, viewerId: string): Promise<boolean> {
    const row = await this.x.first("SELECT 1 AS one FROM observability_shares WHERE owner_id = ? AND viewer_id = ? LIMIT 1", [ownerId, viewerId])
    return !!row
  }

  async deleteByOwner(ownerId: string): Promise<void> {
    await this.x.run("DELETE FROM observability_shares WHERE owner_id = ?", [ownerId])
  }

  async deleteByViewer(viewerId: string): Promise<void> {
    await this.x.run("DELETE FROM observability_shares WHERE viewer_id = ?", [viewerId])
  }
}

class SharedDeviceCodeRepo implements DeviceCodeRepo {
  constructor(private x: SqlExecutor) {}

  async create(code: DeviceCode): Promise<void> {
    await this.x.run(`INSERT INTO device_codes (${DEVICE_COLS}) VALUES (?, ?, ?, ?, ?, ?)`, [code.deviceCode, code.userCode, code.expiresAt, code.userId ?? null, code.sessionToken ?? null, code.createdAt])
  }

  async findByDeviceCode(deviceCode: string): Promise<DeviceCode | null> {
    const row = await this.x.first(`SELECT ${DEVICE_COLS} FROM device_codes WHERE device_code = ?`, [deviceCode])
    return row ? toDeviceCode(row) : null
  }

  async findByUserCode(userCode: string): Promise<DeviceCode | null> {
    const row = await this.x.first(`SELECT ${DEVICE_COLS} FROM device_codes WHERE user_code = ?`, [userCode])
    return row ? toDeviceCode(row) : null
  }

  async verify(deviceCode: string, userId: string, sessionToken: string): Promise<void> {
    await this.x.run("UPDATE device_codes SET user_id = ?, session_token = ? WHERE device_code = ?", [userId, sessionToken, deviceCode])
  }

  async deleteExpired(): Promise<void> {
    await this.x.run("DELETE FROM device_codes WHERE expires_at < ?", [new Date().toISOString()])
  }

  async delete(deviceCode: string): Promise<void> {
    await this.x.run("DELETE FROM device_codes WHERE device_code = ?", [deviceCode])
  }
}

function toPerformanceSummaryRecord(r: any): PerformanceSummaryRecord {
  return {
    hour: r.hour,
    metricScope: r.metric_scope,
    keyId: r.key_id,
    model: r.model,
    upstream: r.upstream ?? null,
    sourceApi: r.source_api,
    targetApi: r.target_api,
    stream: r.stream === 1,
    runtimeLocation: r.runtime_location,
    requests: r.requests,
    errors: r.errors,
    totalMsSum: r.total_ms_sum,
  }
}

function toPerformanceBucketRecord(r: any): PerformanceBucketRecord {
  return {
    hour: r.hour,
    metricScope: r.metric_scope,
    keyId: r.key_id,
    model: r.model,
    upstream: r.upstream ?? null,
    sourceApi: r.source_api,
    targetApi: r.target_api,
    stream: r.stream === 1,
    runtimeLocation: r.runtime_location,
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
    await this.x.run(
      `INSERT INTO performance_summary (${PERF_SUMMARY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (hour, metric_scope, key_id, model, COALESCE(upstream, ''), source_api, target_api, stream, runtime_location)
       DO UPDATE SET requests = requests + 1, errors = errors + excluded.errors, total_ms_sum = total_ms_sum + excluded.total_ms_sum`,
      [
        entry.hour, entry.metricScope, entry.keyId, entry.model, upstream,
        entry.sourceApi, entry.targetApi, streamInt, entry.runtimeLocation,
        errorInt, durationMs,
      ],
    )

    const { lowerMs, upperMs } = latencyBucketForMs(durationMs)
    await this.x.run(
      `INSERT INTO performance_latency_buckets (${PERF_BUCKET_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (hour, metric_scope, key_id, model, COALESCE(upstream, ''), source_api, target_api, stream, runtime_location, lower_ms, upper_ms)
       DO UPDATE SET count = count + 1`,
      [
        entry.hour, entry.metricScope, entry.keyId, entry.model, upstream,
        entry.sourceApi, entry.targetApi, streamInt, entry.runtimeLocation,
        lowerMs, upperMs,
      ],
    )
  }

  async query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string; metricScope?: PerformanceMetricScope }): Promise<{ summary: PerformanceSummaryRecord[]; buckets: PerformanceBucketRecord[] }> {
    const summary = await this.queryTable("performance_summary", PERF_SUMMARY_COLS, opts)
    const buckets = await this.queryTable("performance_latency_buckets", PERF_BUCKET_COLS, opts)
    return {
      summary: summary.map(toPerformanceSummaryRecord),
      buckets: buckets.map(toPerformanceBucketRecord),
    }
  }

  private async queryTable(table: string, cols: string, opts: { keyId?: string; keyIds?: string[]; start: string; end: string; metricScope?: PerformanceMetricScope }): Promise<any[]> {
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
  }
}

function toResponsesItemRecord(r: any): ResponsesItemRecord {
  return {
    id: r.id,
    apiKeyId: r.api_key_id ?? null,
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

  async lookupMany(ids: string[], apiKeyId?: string): Promise<ResponsesItemRecord[]> {
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
