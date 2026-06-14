import type { BillingDimension, ModelPricing, UpstreamKind } from "@vnext/protocols/common"

export interface ApiKey {
  id: string
  name: string
  key: string
  createdAt: string
  lastUsedAt?: string
  ownerId?: string
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
}

export interface GitHubUser {
  id: number
  login: string
  name: string | null
  avatar_url: string
}

export interface GitHubAccount {
  token: string
  accountType: string
  user: GitHubUser
  ownerId?: string
  enabled?: boolean
  sortOrder?: number
  /** JSON object {flagId: bool} — per-upstream feature gate overrides. */
  flagOverrides?: Record<string, boolean>
  updatedAt?: string
}

export type { UpstreamRecord } from '@vnext/protocols/common'

export type TokenUsage = Partial<Record<BillingDimension, number>>

export interface UsageRecord {
  keyId: string
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
  id: string
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
  id: string
  code: string
  name: string
  email?: string
  createdAt: string
  usedAt?: string
  usedBy?: string
}

export interface UserSession {
  token: string
  userId: string
  createdAt: string
  expiresAt: string
}

export interface ApiKeyRepo {
  list(): Promise<ApiKey[]>
  listByOwner(ownerId: string): Promise<ApiKey[]>
  findByRawKey(rawKey: string): Promise<ApiKey | null>
  getById(id: string): Promise<ApiKey | null>
  save(key: ApiKey): Promise<void>
  delete(id: string): Promise<boolean>
  deleteAll(): Promise<void>
  /** Bump last_used_at to now. No-op if id does not exist. */
  touchLastUsed(id: string): Promise<void>
}

export interface GitHubRepo {
  listAccounts(): Promise<GitHubAccount[]>
  listAccountsByOwner(ownerId: string): Promise<GitHubAccount[]>
  getAccount(userId: number, ownerId?: string): Promise<GitHubAccount | null>
  saveAccount(userId: number, account: GitHubAccount): Promise<void>
  deleteAccount(userId: number, ownerId?: string): Promise<void>
  deleteAllAccounts(): Promise<void>
  getActiveId(): Promise<number | null>
  setActiveId(userId: number): Promise<void>
  clearActiveId(): Promise<void>
  getActiveIdForUser(ownerId: string): Promise<number | null>
  setActiveIdForUser(ownerId: string, userId: number): Promise<void>
  clearActiveIdForUser(ownerId: string): Promise<void>
}

export interface UpstreamRepo {
  list(opts?: { ownerId?: string; includeDisabled?: boolean }): Promise<UpstreamRecord[]>
  getById(id: string): Promise<UpstreamRecord | null>
  save(upstream: UpstreamRecord): Promise<void>
  delete(id: string): Promise<boolean>
  deleteAll(): Promise<void>
}

export interface UsageRepo {
  /** Additive upsert: tokens += excluded.tokens, requests += excluded.requests. */
  record(r: UsageRecord): Promise<void>
  /** Replacement upsert (used by data-transfer import): clears bucket's
   *  dimension rows first, then inserts the new record's dimensions. */
  set(r: UsageRecord): Promise<void>
  query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<UsageRecord[]>
  listAll(): Promise<UsageRecord[]>
  deleteAll(): Promise<void>
}

export interface CacheRepo {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface LatencyRecord {
  keyId: string
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
    keyId: string
    model: string
    hour: string
    colo: string
    stream: boolean
    totalMs: number
    upstreamMs: number
    ttfbMs: number
    tokenMiss: boolean
  }): Promise<void>
  query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<LatencyRecord[]>
  deleteAll(): Promise<void>
}

export type PerformanceMetricScope = "request_total" | "upstream_success"
export type PerformanceSourceApi = "messages" | "responses" | "chat-completions" | "gemini" | "embeddings"
export type PerformanceTargetApi = "messages" | "responses" | "chat-completions" | "embeddings"

export interface PerformanceSummaryRecord {
  hour: string
  metricScope: PerformanceMetricScope
  keyId: string
  model: string
  upstream: string | null
  sourceApi: PerformanceSourceApi
  targetApi: PerformanceTargetApi
  stream: boolean
  runtimeLocation: string
  requests: number
  errors: number
  totalMsSum: number
}

export interface PerformanceBucketRecord {
  hour: string
  metricScope: PerformanceMetricScope
  keyId: string
  model: string
  upstream: string | null
  sourceApi: PerformanceSourceApi
  targetApi: PerformanceTargetApi
  stream: boolean
  runtimeLocation: string
  lowerMs: number
  upperMs: number
  count: number
}

export interface PerformanceRecordInput {
  hour: string
  metricScope: PerformanceMetricScope
  keyId: string
  model: string
  upstream?: string | null
  sourceApi: PerformanceSourceApi
  targetApi: PerformanceTargetApi
  stream: boolean
  runtimeLocation: string
  durationMs: number
  isError: boolean
}

export interface PerformanceRepo {
  record(entry: PerformanceRecordInput): Promise<void>
  query(opts: {
    keyId?: string
    keyIds?: string[]
    start: string
    end: string
    metricScope?: PerformanceMetricScope
  }): Promise<{ summary: PerformanceSummaryRecord[]; buckets: PerformanceBucketRecord[] }>
  deleteAll(): Promise<void>
}

export interface UserRepo {
  create(user: User): Promise<void>
  getById(id: string): Promise<User | null>
  findByKey(userKey: string): Promise<User | null>
  findByEmail(email: string): Promise<User | null>
  list(): Promise<User[]>
  update(id: string, fields: Partial<Pick<User, "name" | "email" | "avatarUrl" | "disabled" | "lastLoginAt" | "userKey" | "passwordHash">>): Promise<void>
  delete(id: string): Promise<void>
}

export interface InviteCodeRepo {
  create(code: InviteCode): Promise<void>
  findByCode(code: string): Promise<InviteCode | null>
  list(): Promise<InviteCode[]>
  markUsed(id: string, userId: string): Promise<void>
  clearUsedBy(userId: string): Promise<void>
  delete(id: string): Promise<void>
}

export interface SessionRepo {
  create(session: UserSession): Promise<void>
  findByToken(token: string): Promise<UserSession | null>
  deleteByUserId(userId: string): Promise<void>
  deleteExpired(): Promise<void>
}

export interface ClientPresence {
  clientId: string
  clientName: string
  keyId: string | null
  keyName: string | null
  ownerId: string | null
  gatewayUrl: string | null
  lastSeenAt: string
}

export interface ClientPresenceRepo {
  upsert(presence: ClientPresence): Promise<void>
  list(): Promise<ClientPresence[]>
  listByOwner(ownerId: string): Promise<ClientPresence[]>
  listByKeyIds(keyIds: string[]): Promise<ClientPresence[]>
  pruneStale(olderThanMinutes: number): Promise<void>
}

export interface WebSearchUsageRecord {
  keyId: string
  hour: string
  searches: number
  successes: number
  failures: number
}

export interface WebSearchUsageRepo {
  record(keyId: string, hour: string, success: boolean): Promise<void>
  query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<WebSearchUsageRecord[]>
  deleteAll(): Promise<void>
}

export interface WebSearchEngineUsageRecord {
  keyId: string
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
  record(keyId: string, engineId: string, hour: string, attempt: { ok: boolean; resultCount: number; durationMs: number }): Promise<void>
  query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<WebSearchEngineUsageRecord[]>
  deleteAll(): Promise<void>
}

export interface KeyAssignment {
  keyId: string
  userId: string
  assignedBy: string
  assignedAt: string
}

export interface KeyAssignmentRepo {
  assign(keyId: string, userId: string, assignedBy: string): Promise<void>
  unassign(keyId: string, userId: string): Promise<void>
  listByUser(userId: string): Promise<KeyAssignment[]>
  listByKey(keyId: string): Promise<KeyAssignment[]>
  deleteByKey(keyId: string): Promise<void>
  deleteByUser(userId: string): Promise<void>
}

export interface ObservabilityShare {
  ownerId: string
  viewerId: string
  grantedBy: string
  grantedAt: string
}

export interface ObservabilityShareRepo {
  share(ownerId: string, viewerId: string, grantedBy: string): Promise<void>
  unshare(ownerId: string, viewerId: string): Promise<void>
  listByOwner(ownerId: string): Promise<ObservabilityShare[]>
  listByViewer(viewerId: string): Promise<ObservabilityShare[]>
  isGranted(ownerId: string, viewerId: string): Promise<boolean>
  deleteByOwner(ownerId: string): Promise<void>
  deleteByViewer(viewerId: string): Promise<void>
}

export interface DeviceCode {
  deviceCode: string
  userCode: string
  expiresAt: string
  userId?: string
  sessionToken?: string
  createdAt: string
}

export interface DeviceCodeRepo {
  create(code: DeviceCode): Promise<void>
  findByDeviceCode(deviceCode: string): Promise<DeviceCode | null>
  findByUserCode(userCode: string): Promise<DeviceCode | null>
  verify(deviceCode: string, userId: string, sessionToken: string): Promise<void>
  deleteExpired(): Promise<void>
  delete(deviceCode: string): Promise<void>
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
  id: string
  apiKeyId: string | null
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
  lookupMany(ids: string[], apiKeyId?: string): Promise<ResponsesItemRecord[]>
  deleteExpired(now: string): Promise<void>
  deleteAll(): Promise<void>
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
}
