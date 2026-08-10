import type { BillingDimension, ModelPricing, UpstreamKind, UpstreamRecord } from "@vibe-llm/protocols/common"
import type { ProxyRepo, ProxyBackoffRepo } from "@vibe-core/proxy-repo"
import type { SearchConfig } from "../shared/web-search-providers.ts"
import type { ApiKeyId, DeviceCodeToken, GitHubAccountId, InviteCodeId, ResponsesItemId, SessionToken, UpstreamId, UserId } from "./branded-ids.ts"

export type { SearchConfig, WebSearchProviderName } from "../shared/web-search-providers.ts"
export type { ProxyRepo, ProxyBackoffRepo, ProxyRecord, ProxyFallbackEntry, BackoffRow } from "@vibe-core/proxy-repo"

export interface ApiKey {
  id: ApiKeyId
  name: string
  key: string
  createdAt: string
  lastUsedAt?: string
  ownerId?: UserId
  quotaRequestsPerDay?: number
  quotaTokensPerDay?: number
  webSearchEnabled?: boolean
  webSearchLangsearchKey?: string
  webSearchTavilyKey?: string

  webSearchMsGroundingKey?: string
  /** Ordered list of engine ids to try, e.g. ["msGrounding","langsearch","tavily","bing","copilot"]. Empty/undefined falls back to legacy resolution. */
  webSearchPriority?: string[]
  /** When set, resolves to source api_key.id's webSearchLangsearchKey at request time. Mutually exclusive with webSearchLangsearchKey. */
  webSearchLangsearchRef?: string
  /** Same as above for Tavily. */
  webSearchTavilyRef?: string
  /** Same as above for Microsoft Grounding. */
  webSearchMsGroundingRef?: string
  /** Rolling window in seconds for per-key request dumps. `null` = capture disabled. */
  dumpRetentionSeconds?: number | null
}

export interface GitHubUser {
  id: GitHubAccountId
  login: string
  name: string | null
  avatar_url: string
}

export interface GitHubAccount {
  token: string
  accountType: string
  user: GitHubUser
  ownerId?: UserId
  enabled?: boolean
  sortOrder?: number
  /** JSON object {flagId: bool} — per-upstream feature gate overrides. */
  flagOverrides?: Record<string, boolean>
  updatedAt?: string
  /** GitHub host: "github.com" or a "<tenant>.ghe.com" tenant. Defaults to
   *  "github.com" when absent (device-flow rows imported before Path-B). */
  githubHost?: string
  /** How this account was obtained. "device-flow" is the classic OAuth flow;
   *  "paste" is Path-B (user pasted a gho_ token extracted from VS Code). */
  source?: "device-flow" | "paste"
}

export type { UpstreamRecord } from '@vibe-llm/protocols/common'

export type TokenUsage = Partial<Record<BillingDimension, number>>

export interface UsageRecord {
  keyId: ApiKeyId
  /** Public model id (post-variant-merge). */
  model: string
  /** Raw upstream model id used for pricing lookup. */
  modelKey: string
  /** Provider-prefixed upstream id, e.g. "copilot:<id>"; null for pre-port rows. */
  upstream: string | null
  /** SDK/client distinguisher; '' when unknown (vNext-specific PK part). */
  client: string
  hour: string
  requests: number
  /** Per-dimension token counts; dimensions with 0 tokens are dropped. */
  tokens: TokenUsage
  /** Frozen pricing snapshot reassembled from per-dimension unit_price on read,
   *  or supplied at write time from `provider.getPricingForModelKey`. */
  cost: ModelPricing | null
}

export interface User {
  id: UserId
  name: string
  email?: string
  avatarUrl?: string
  createdAt: string
  disabled: boolean
  lastLoginAt?: string
  userKey?: string
  passwordHash?: string
}

export interface InviteCode {
  id: InviteCodeId
  code: string
  name: string
  email?: string
  createdAt: string
  usedAt?: string
  usedBy?: UserId
}

export interface UserSession {
  token: SessionToken
  userId: UserId
  createdAt: string
  expiresAt: string
}

export interface ApiKeyRepo {
  list(): Promise<ApiKey[]>
  listByOwner(ownerId: UserId): Promise<ApiKey[]>
  findByRawKey(rawKey: string): Promise<ApiKey | null>
  getById(id: ApiKeyId): Promise<ApiKey | null>
  save(key: ApiKey): Promise<void>
  delete(id: ApiKeyId): Promise<boolean>
  deleteAll(): Promise<void>
  /** Bump last_used_at to now. No-op if id does not exist. */
  touchLastUsed(id: ApiKeyId): Promise<void>
}

export interface GitHubRepo {
  listAccounts(): Promise<GitHubAccount[]>
  listAccountsByOwner(ownerId: UserId): Promise<GitHubAccount[]>
  getAccount(userId: GitHubAccountId, ownerId?: UserId): Promise<GitHubAccount | null>
  saveAccount(userId: GitHubAccountId, account: GitHubAccount): Promise<void>
  deleteAccount(userId: GitHubAccountId, ownerId?: UserId): Promise<void>
  deleteAllAccounts(): Promise<void>
  getActiveId(): Promise<GitHubAccountId | null>
  setActiveId(userId: GitHubAccountId): Promise<void>
  clearActiveId(): Promise<void>
  getActiveIdForUser(ownerId: UserId): Promise<GitHubAccountId | null>
  setActiveIdForUser(ownerId: UserId, userId: GitHubAccountId): Promise<void>
  clearActiveIdForUser(ownerId: UserId): Promise<void>
}

export interface UpstreamRepo {
  list(opts?: { ownerId?: UserId; includeDisabled?: boolean }): Promise<UpstreamRecord<unknown>[]>
  /** TState defaults to `unknown` — non-typed callers get an `unknown` state
   *  they must narrow themselves (usually via a provider-side assertion).
   *  Typed callers pin the shape, e.g. `getById<CodexUpstreamState>(id)`. */
  getById<TState = unknown>(id: UpstreamId): Promise<UpstreamRecord<TState> | null>
  save(upstream: UpstreamRecord<unknown>): Promise<void>
  delete(id: UpstreamId): Promise<boolean>
  deleteAll(): Promise<void>
  /** Atomic read-modify-write of the `state` column. The updater sees the
   *  current state coerced to TState; the return value replaces it. Backends
   *  implement this in a single transaction so concurrent rotations don't
   *  clobber each other. Throws if no row exists for `id`. */
  saveState<TState>(id: UpstreamId, updater: (current: TState) => TState): Promise<void>
}

export interface UsageRepo {
  /** Additive upsert: tokens += excluded.tokens, requests += excluded.requests. */
  record(r: UsageRecord): Promise<void>
  /** Replacement upsert (used by data-transfer import): clears bucket's
   *  dimension rows first, then inserts the new record's dimensions. */
  set(r: UsageRecord): Promise<void>
  query(opts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string }): Promise<UsageRecord[]>
  listAll(): Promise<UsageRecord[]>
  deleteAll(): Promise<void>
}

export interface CacheRepo {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface LatencyRecord {
  keyId: ApiKeyId
  model: string
  hour: string
  colo: string
  stream: boolean
  requests: number
  totalMs: number
  upstreamMs: number
  ttfbMs: number
  tokenMiss: number
}

export interface LatencyRepo {
  record(entry: {
    keyId: ApiKeyId
    model: string
    hour: string
    colo: string
    stream: boolean
    totalMs: number
    upstreamMs: number
    ttfbMs: number
    tokenMiss: boolean
  }): Promise<void>
  query(opts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string }): Promise<LatencyRecord[]>
  deleteAll(): Promise<void>
}

export type PerformanceMetricScope = "request_total" | "upstream_success"
export type PerformanceSourceApi = "messages" | "responses" | "chat-completions" | "gemini" | "embeddings"
export type PerformanceTargetApi = "messages" | "responses" | "chat-completions" | "embeddings"
/** Sub-operation discriminator; null for request-level rows. See
 *  PerformanceOperation in @vibe-llm/protocols/common. */
export type PerformanceOperation = "image_generation" | "image_edit"

export interface PerformanceSummaryRecord {
  hour: string
  metricScope: PerformanceMetricScope
  keyId: ApiKeyId
  model: string
  upstream: string | null
  sourceApi: PerformanceSourceApi
  targetApi: PerformanceTargetApi
  stream: boolean
  runtimeLocation: string
  operation: PerformanceOperation | null
  requests: number
  errors: number
  totalMsSum: number
}

export interface PerformanceBucketRecord {
  hour: string
  metricScope: PerformanceMetricScope
  keyId: ApiKeyId
  model: string
  upstream: string | null
  sourceApi: PerformanceSourceApi
  targetApi: PerformanceTargetApi
  stream: boolean
  runtimeLocation: string
  operation: PerformanceOperation | null
  lowerMs: number
  upperMs: number
  count: number
}

export interface PerformanceRecordInput {
  hour: string
  metricScope: PerformanceMetricScope
  keyId: ApiKeyId
  model: string
  upstream?: string | null
  sourceApi: PerformanceSourceApi
  targetApi: PerformanceTargetApi
  stream: boolean
  runtimeLocation: string
  /** Sub-operation discriminator; omit/null for the enclosing request row. */
  operation?: PerformanceOperation | null
  durationMs: number
  isError: boolean
}

export interface PerformanceRepo {
  record(entry: PerformanceRecordInput): Promise<void>
  query(opts: {
    keyId?: ApiKeyId
    keyIds?: ApiKeyId[]
    start: string
    end: string
    metricScope?: PerformanceMetricScope
  }): Promise<{ summary: PerformanceSummaryRecord[]; buckets: PerformanceBucketRecord[] }>
  deleteAll(): Promise<void>
}

export interface UserRepo {
  create(user: User): Promise<void>
  getById(id: UserId): Promise<User | null>
  findByKey(userKey: string): Promise<User | null>
  findByEmail(email: string): Promise<User | null>
  list(): Promise<User[]>
  update(id: UserId, fields: Partial<Pick<User, "name" | "email" | "avatarUrl" | "disabled" | "lastLoginAt" | "userKey" | "passwordHash">>): Promise<void>
  delete(id: UserId): Promise<void>
}

export interface InviteCodeRepo {
  create(code: InviteCode): Promise<void>
  findByCode(code: string): Promise<InviteCode | null>
  list(): Promise<InviteCode[]>
  markUsed(id: InviteCodeId, userId: UserId): Promise<void>
  clearUsedBy(userId: UserId): Promise<void>
  delete(id: InviteCodeId): Promise<void>
}

export interface SessionRepo {
  create(session: UserSession): Promise<void>
  findByToken(token: SessionToken): Promise<UserSession | null>
  deleteByUserId(userId: UserId): Promise<void>
  deleteExpired(): Promise<void>
}

export interface ClientPresence {
  clientId: string
  clientName: string
  keyId: ApiKeyId | null
  keyName: string | null
  ownerId: UserId | null
  gatewayUrl: string | null
  lastSeenAt: string
}

export interface ClientPresenceRepo {
  upsert(presence: ClientPresence): Promise<void>
  list(): Promise<ClientPresence[]>
  listByOwner(ownerId: UserId): Promise<ClientPresence[]>
  listByKeyIds(keyIds: ApiKeyId[]): Promise<ClientPresence[]>
  pruneStale(olderThanMinutes: number): Promise<void>
}

export interface WebSearchUsageRecord {
  keyId: ApiKeyId
  hour: string
  searches: number
  successes: number
  failures: number
}

export interface WebSearchUsageRepo {
  record(keyId: ApiKeyId, hour: string, success: boolean): Promise<void>
  query(opts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string }): Promise<WebSearchUsageRecord[]>
  deleteAll(): Promise<void>
}

export interface WebSearchEngineUsageRecord {
  keyId: ApiKeyId
  engineId: string
  hour: string
  attempts: number
  successes: number
  failures: number
  emptyResults: number
  totalResults: number
  successDurationMs: number
  failureDurationMs: number
}

export interface WebSearchEngineUsageRepo {
  record(keyId: ApiKeyId, engineId: string, hour: string, attempt: { ok: boolean; resultCount: number; durationMs: number }): Promise<void>
  query(opts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string }): Promise<WebSearchEngineUsageRecord[]>
  deleteAll(): Promise<void>
}

export interface KeyAssignment {
  keyId: ApiKeyId
  userId: UserId
  assignedBy: UserId
  assignedAt: string
}

export interface KeyAssignmentRepo {
  assign(keyId: ApiKeyId, userId: UserId, assignedBy: UserId): Promise<void>
  unassign(keyId: ApiKeyId, userId: UserId): Promise<void>
  listByUser(userId: UserId): Promise<KeyAssignment[]>
  listByKey(keyId: ApiKeyId): Promise<KeyAssignment[]>
  deleteByKey(keyId: ApiKeyId): Promise<void>
  deleteByUser(userId: UserId): Promise<void>
}

export interface ObservabilityShare {
  ownerId: UserId
  viewerId: UserId
  grantedBy: UserId
  grantedAt: string
}

export interface ObservabilityShareRepo {
  share(ownerId: UserId, viewerId: UserId, grantedBy: UserId): Promise<void>
  unshare(ownerId: UserId, viewerId: UserId): Promise<void>
  listByOwner(ownerId: UserId): Promise<ObservabilityShare[]>
  listByViewer(viewerId: UserId): Promise<ObservabilityShare[]>
  isGranted(ownerId: UserId, viewerId: UserId): Promise<boolean>
  deleteByOwner(ownerId: UserId): Promise<void>
  deleteByViewer(viewerId: UserId): Promise<void>
}

export interface DeviceCode {
  deviceCode: DeviceCodeToken
  userCode: string
  expiresAt: string
  userId?: UserId
  sessionToken?: SessionToken
  createdAt: string
}

export interface DeviceCodeRepo {
  create(code: DeviceCode): Promise<void>
  findByDeviceCode(deviceCode: DeviceCodeToken): Promise<DeviceCode | null>
  findByUserCode(userCode: string): Promise<DeviceCode | null>
  verify(deviceCode: DeviceCodeToken, userId: UserId, sessionToken: SessionToken): Promise<void>
  deleteExpired(): Promise<void>
  delete(deviceCode: DeviceCodeToken): Promise<void>
}

/**
 * A stored Responses-API output item that the gateway minted on the client's
 * behalf (currently only `web_search_call`). Persisted so that when a SDK
 * client echoes the item id back in a multi-turn request input, the gateway
 * can restore the private payload (search results, queries) and replay it
 * into the chat-fallback conversation.
 *
 * `itemJson` is the public-facing item exactly as the gateway emitted it.
 * `privateJson` is gateway-side state (e.g. raw search results) the client
 * never sees but is needed to reconstruct an equivalent tool call/response
 * pair on the next turn.
 */
export interface ResponsesItemRecord {
  id: ResponsesItemId
  apiKeyId: ApiKeyId | null
  kind: string
  itemJson: string
  privateJson: string | null
  createdAt: string
  expiresAt: string | null
}

export interface ResponsesItemsRepo {
  insertMany(records: ResponsesItemRecord[]): Promise<void>
  /**
   * Look up stored items by id, optionally restricted to a single owning
   * api key. Pass `apiKeyId` to enforce cross-account isolation — items
   * minted under a different key (or items whose owner is null) are filtered
   * out. Omit to read across all owners (admin / migration paths only).
   */
  lookupMany(ids: ResponsesItemId[], apiKeyId?: ApiKeyId): Promise<ResponsesItemRecord[]>
  deleteExpired(now: string): Promise<void>
  deleteAll(): Promise<void>
}

/**
 * Singleton global search config for the ported Responses server-tool shim
 * (Phase 13-C). Blob-style: `get()` returns `null` when unset so callers can
 * apply defaults; `save()` writes the validated shape.
 *
 * Ported 1:1 from copilot-gateway `SearchConfigRepo` — see repo/types.ts:255
 * in the reference project.
 */
export interface SearchConfigRepo {
  get(): Promise<SearchConfig | null>
  save(config: SearchConfig): Promise<void>
}

export interface Repo {
  apiKeys: ApiKeyRepo
  github: GitHubRepo
  upstreams: UpstreamRepo
  usage: UsageRepo
  cache: CacheRepo
  latency: LatencyRepo
  performance: PerformanceRepo
  users: UserRepo
  inviteCodes: InviteCodeRepo
  sessions: SessionRepo
  presence: ClientPresenceRepo
  webSearchUsage: WebSearchUsageRepo
  webSearchEngineUsage: WebSearchEngineUsageRepo
  keyAssignments: KeyAssignmentRepo
  observabilityShares: ObservabilityShareRepo
  deviceCodes: DeviceCodeRepo
  responsesItems: ResponsesItemsRepo
  searchConfig: SearchConfigRepo
  proxies: ProxyRepo
  proxyBackoffs: ProxyBackoffRepo
}
