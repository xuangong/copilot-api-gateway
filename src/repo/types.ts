export interface ApiKey {
  id: string
  name: string
  key: string
  createdAt: string
  lastUsedAt?: string
  ownerId?: string
  quotaRequestsPerDay?: number
  quotaTokensPerDay?: number
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
}

export interface UsageRecord {
  keyId: string
  model: string
  hour: string
  client: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface User {
  id: string
  name: string
  createdAt: string
  disabled: boolean
  lastLoginAt?: string
  userKey?: string
}

export interface InviteCode {
  id: string
  code: string
  name: string
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

export interface UsageRepo {
  record(
    keyId: string,
    model: string,
    hour: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
    client?: string,
    cacheReadTokens?: number,
    cacheCreationTokens?: number,
  ): Promise<void>
  query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<UsageRecord[]>
  listAll(): Promise<UsageRecord[]>
  set(record: UsageRecord): Promise<void>
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

export interface UserRepo {
  create(user: User): Promise<void>
  getById(id: string): Promise<User | null>
  findByKey(userKey: string): Promise<User | null>
  list(): Promise<User[]>
  update(id: string, fields: Partial<Pick<User, "name" | "disabled" | "lastLoginAt" | "userKey">>): Promise<void>
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

export interface Repo {
  apiKeys: ApiKeyRepo
  github: GitHubRepo
  usage: UsageRepo
  cache: CacheRepo
  latency: LatencyRepo
  users: UserRepo
  inviteCodes: InviteCodeRepo
  sessions: SessionRepo
  presence: ClientPresenceRepo
}
