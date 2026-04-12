import type {
  ApiKey,
  ApiKeyRepo,
  CacheRepo,
  ClientPresence,
  ClientPresenceRepo,
  GitHubAccount,
  GitHubRepo,
  InviteCode,
  InviteCodeRepo,
  LatencyRecord,
  LatencyRepo,
  Repo,
  SessionRepo,
  UsageRecord,
  UsageRepo,
  User,
  UserRepo,
  UserSession,
} from "./types"

interface D1Result<T = Record<string, unknown>> {
  results: T[]
  success: boolean
  meta: Record<string, unknown>
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result>
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
}

class D1ApiKeyRepo implements ApiKeyRepo {
  constructor(private db: D1Database) {}

  async list(): Promise<ApiKey[]> {
    const { results } = await this.db
      .prepare("SELECT id, name, key, created_at, last_used_at, owner_id FROM api_keys ORDER BY created_at")
      .all<{ id: string; name: string; key: string; created_at: string; last_used_at: string | null; owner_id: string | null }>()
    return results.map(toApiKey)
  }

  async listByOwner(ownerId: string): Promise<ApiKey[]> {
    const { results } = await this.db
      .prepare("SELECT id, name, key, created_at, last_used_at, owner_id FROM api_keys WHERE owner_id = ? ORDER BY created_at")
      .bind(ownerId)
      .all<{ id: string; name: string; key: string; created_at: string; last_used_at: string | null; owner_id: string | null }>()
    return results.map(toApiKey)
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const row = await this.db
      .prepare("SELECT id, name, key, created_at, last_used_at, owner_id FROM api_keys WHERE key = ?")
      .bind(rawKey)
      .first<{ id: string; name: string; key: string; created_at: string; last_used_at: string | null; owner_id: string | null }>()
    return row ? toApiKey(row) : null
  }

  async getById(id: string): Promise<ApiKey | null> {
    const row = await this.db
      .prepare("SELECT id, name, key, created_at, last_used_at, owner_id FROM api_keys WHERE id = ?")
      .bind(id)
      .first<{ id: string; name: string; key: string; created_at: string; last_used_at: string | null; owner_id: string | null }>()
    return row ? toApiKey(row) : null
  }

  async save(key: ApiKey): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key, created_at, last_used_at, owner_id) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, key = excluded.key, last_used_at = excluded.last_used_at, owner_id = excluded.owner_id`,
      )
      .bind(key.id, key.name, key.key, key.createdAt, key.lastUsedAt ?? null, key.ownerId ?? null)
      .run()
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run()
    return ((result.meta.changes as number) ?? 0) > 0
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare("DELETE FROM api_keys").run()
  }
}

function toApiKey(row: { id: string; name: string; key: string; created_at: string; last_used_at: string | null; owner_id: string | null }): ApiKey {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    ownerId: row.owner_id ?? undefined,
  }
}

class D1GitHubRepo implements GitHubRepo {
  constructor(private db: D1Database) {}

  async listAccounts(): Promise<GitHubAccount[]> {
    const { results } = await this.db
      .prepare("SELECT user_id, token, account_type, login, name, avatar_url, owner_id FROM github_accounts")
      .all<{ user_id: number; token: string; account_type: string; login: string; name: string | null; avatar_url: string; owner_id: string | null }>()
    return results.map(toGitHubAccount)
  }

  async listAccountsByOwner(ownerId: string): Promise<GitHubAccount[]> {
    const { results } = await this.db
      .prepare("SELECT user_id, token, account_type, login, name, avatar_url, owner_id FROM github_accounts WHERE owner_id = ?")
      .bind(ownerId)
      .all<{ user_id: number; token: string; account_type: string; login: string; name: string | null; avatar_url: string; owner_id: string | null }>()
    return results.map(toGitHubAccount)
  }

  async getAccount(userId: number, ownerId?: string): Promise<GitHubAccount | null> {
    const ownerVal = ownerId ?? ""
    const row = await this.db
      .prepare("SELECT user_id, token, account_type, login, name, avatar_url, owner_id FROM github_accounts WHERE user_id = ? AND owner_id = ?")
      .bind(userId, ownerVal)
      .first<{ user_id: number; token: string; account_type: string; login: string; name: string | null; avatar_url: string; owner_id: string | null }>()
    return row ? toGitHubAccount(row) : null
  }

  async saveAccount(userId: number, account: GitHubAccount): Promise<void> {
    const ownerId = account.ownerId ?? ""
    await this.db
      .prepare(
        `INSERT INTO github_accounts (user_id, token, account_type, login, name, avatar_url, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, owner_id) DO UPDATE SET token = excluded.token, account_type = excluded.account_type, login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url`,
      )
      .bind(userId, account.token, account.accountType, account.user.login, account.user.name, account.user.avatar_url, ownerId)
      .run()
  }

  async deleteAccount(userId: number, ownerId?: string): Promise<void> {
    if (ownerId !== undefined) {
      await this.db.prepare("DELETE FROM github_accounts WHERE user_id = ? AND owner_id = ?").bind(userId, ownerId).run()
    } else {
      await this.db.prepare("DELETE FROM github_accounts WHERE user_id = ?").bind(userId).run()
    }
  }

  async deleteAllAccounts(): Promise<void> {
    await this.db.prepare("DELETE FROM github_accounts").run()
    await this.clearActiveId()
  }

  async getActiveId(): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT value FROM config WHERE key = 'active_github_account'")
      .first<{ value: string }>()
    return row ? Number(row.value) : null
  }

  async setActiveId(userId: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES ('active_github_account', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(String(userId))
      .run()
  }

  async clearActiveId(): Promise<void> {
    await this.db.prepare("DELETE FROM config WHERE key = 'active_github_account'").run()
  }

  async getActiveIdForUser(ownerId: string): Promise<number | null> {
    const configKey = `active_github_account:${ownerId}`
    const row = await this.db
      .prepare("SELECT value FROM config WHERE key = ?")
      .bind(configKey)
      .first<{ value: string }>()
    return row ? Number(row.value) : null
  }

  async setActiveIdForUser(ownerId: string, userId: number): Promise<void> {
    const configKey = `active_github_account:${ownerId}`
    await this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(configKey, String(userId))
      .run()
  }

  async clearActiveIdForUser(ownerId: string): Promise<void> {
    const configKey = `active_github_account:${ownerId}`
    await this.db.prepare("DELETE FROM config WHERE key = ?").bind(configKey).run()
  }
}

function toGitHubAccount(row: { user_id: number; token: string; account_type: string; login: string; name: string | null; avatar_url: string; owner_id: string | null }): GitHubAccount {
  return {
    token: row.token,
    accountType: row.account_type,
    ownerId: row.owner_id ?? undefined,
    user: {
      id: row.user_id,
      login: row.login,
      name: row.name,
      avatar_url: row.avatar_url,
    },
  }
}

class D1UsageRepo implements UsageRepo {
  constructor(private db: D1Database) {}

  async record(
    keyId: string,
    model: string,
    hour: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
    client?: string,
    cacheReadTokens?: number,
    cacheCreationTokens?: number,
  ): Promise<void> {
    const c = client || ""
    await this.db
      .prepare(
        `INSERT INTO usage (key_id, model, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key_id, model, hour, client) DO UPDATE SET
           requests = requests + excluded.requests,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens`,
      )
      .bind(keyId, model, hour, c, requests, inputTokens, outputTokens, cacheReadTokens ?? 0, cacheCreationTokens ?? 0)
      .run()
  }

  async query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<UsageRecord[]> {
    let sql: string
    let binds: unknown[]

    if (opts.keyIds && opts.keyIds.length > 0) {
      const placeholders = opts.keyIds.map(() => "?").join(",")
      sql = `SELECT key_id, model, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage WHERE key_id IN (${placeholders}) AND hour >= ? AND hour < ? ORDER BY hour`
      binds = [...opts.keyIds, opts.start, opts.end]
    } else if (opts.keyId) {
      sql = "SELECT key_id, model, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage WHERE key_id = ? AND hour >= ? AND hour < ? ORDER BY hour"
      binds = [opts.keyId, opts.start, opts.end]
    } else {
      sql = "SELECT key_id, model, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage WHERE hour >= ? AND hour < ? ORDER BY hour"
      binds = [opts.start, opts.end]
    }

    const { results } = await this.db
      .prepare(sql)
      .bind(...binds)
      .all<{ key_id: string; model: string; hour: string; client: string; requests: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }>()
    return results.map((r) => ({
      keyId: r.key_id,
      model: r.model,
      hour: r.hour,
      client: r.client || "",
      requests: r.requests,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens ?? 0,
      cacheCreationTokens: r.cache_creation_tokens ?? 0,
    }))
  }

  async listAll(): Promise<UsageRecord[]> {
    const { results } = await this.db
      .prepare("SELECT key_id, model, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage ORDER BY hour")
      .all<{ key_id: string; model: string; hour: string; client: string; requests: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }>()
    return results.map((r) => ({
      keyId: r.key_id,
      model: r.model,
      hour: r.hour,
      client: r.client || "",
      requests: r.requests,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens ?? 0,
      cacheCreationTokens: r.cache_creation_tokens ?? 0,
    }))
  }

  async set(record: UsageRecord): Promise<void> {
    const c = record.client || ""
    await this.db
      .prepare(
        `INSERT INTO usage (key_id, model, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key_id, model, hour, client) DO UPDATE SET
           requests = excluded.requests,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens,
           cache_creation_tokens = excluded.cache_creation_tokens`,
      )
      .bind(record.keyId, record.model, record.hour, c, record.requests, record.inputTokens, record.outputTokens, record.cacheReadTokens ?? 0, record.cacheCreationTokens ?? 0)
      .run()
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare("DELETE FROM usage").run()
  }
}

class D1CacheRepo implements CacheRepo {
  constructor(private db: D1Database) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT value FROM config WHERE key = ?").bind(key).first<{ value: string }>()
    return row?.value ?? null
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(key, value)
      .run()
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM config WHERE key = ?").bind(key).run()
  }
}

class D1LatencyRepo implements LatencyRepo {
  constructor(private db: D1Database) {}

  async record(entry: {
    keyId: string
    model: string
    hour: string
    colo: string
    stream: boolean
    totalMs: number
    upstreamMs: number
    ttfbMs: number
    tokenMiss: boolean
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO latency (key_id, model, hour, colo, stream, requests, total_ms, upstream_ms, ttfb_ms, token_miss)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT (key_id, model, hour, colo, stream) DO UPDATE SET
           requests = requests + 1,
           total_ms = total_ms + excluded.total_ms,
           upstream_ms = upstream_ms + excluded.upstream_ms,
           ttfb_ms = ttfb_ms + excluded.ttfb_ms,
           token_miss = token_miss + excluded.token_miss`,
      )
      .bind(
        entry.keyId,
        entry.model,
        entry.hour,
        entry.colo,
        entry.stream ? 1 : 0,
        entry.totalMs,
        entry.upstreamMs,
        entry.ttfbMs,
        entry.tokenMiss ? 1 : 0,
      )
      .run()
  }

  async query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<LatencyRecord[]> {
    let sql: string
    let binds: unknown[]

    if (opts.keyIds && opts.keyIds.length > 0) {
      const placeholders = opts.keyIds.map(() => "?").join(",")
      sql = `SELECT key_id, model, hour, colo, stream, requests, total_ms, upstream_ms, ttfb_ms, token_miss FROM latency WHERE key_id IN (${placeholders}) AND hour >= ? AND hour < ? ORDER BY hour`
      binds = [...opts.keyIds, opts.start, opts.end]
    } else if (opts.keyId) {
      sql = "SELECT key_id, model, hour, colo, stream, requests, total_ms, upstream_ms, ttfb_ms, token_miss FROM latency WHERE key_id = ? AND hour >= ? AND hour < ? ORDER BY hour"
      binds = [opts.keyId, opts.start, opts.end]
    } else {
      sql = "SELECT key_id, model, hour, colo, stream, requests, total_ms, upstream_ms, ttfb_ms, token_miss FROM latency WHERE hour >= ? AND hour < ? ORDER BY hour"
      binds = [opts.start, opts.end]
    }

    const { results } = await this.db
      .prepare(sql)
      .bind(...binds)
      .all<{
        key_id: string
        model: string
        hour: string
        colo: string
        stream: number
        requests: number
        total_ms: number
        upstream_ms: number
        ttfb_ms: number
        token_miss: number
      }>()
    return results.map((r) => ({
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
    }))
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare("DELETE FROM latency").run()
  }
}

class D1UserRepo implements UserRepo {
  constructor(private db: D1Database) {}

  async create(user: User): Promise<void> {
    await this.db
      .prepare("INSERT INTO users (id, name, created_at, disabled, last_login_at, user_key) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(user.id, user.name, user.createdAt, user.disabled ? 1 : 0, user.lastLoginAt ?? null, user.userKey ?? null)
      .run()
  }

  async getById(id: string): Promise<User | null> {
    const row = await this.db
      .prepare("SELECT id, name, created_at, disabled, last_login_at, user_key FROM users WHERE id = ?")
      .bind(id)
      .first<{ id: string; name: string; created_at: string; disabled: number; last_login_at: string | null; user_key: string | null }>()
    return row ? toUser(row) : null
  }

  async findByKey(userKey: string): Promise<User | null> {
    const row = await this.db
      .prepare("SELECT id, name, created_at, disabled, last_login_at, user_key FROM users WHERE user_key = ?")
      .bind(userKey)
      .first<{ id: string; name: string; created_at: string; disabled: number; last_login_at: string | null; user_key: string | null }>()
    return row ? toUser(row) : null
  }

  async list(): Promise<User[]> {
    const { results } = await this.db
      .prepare("SELECT id, name, created_at, disabled, last_login_at, user_key FROM users ORDER BY created_at")
      .all<{ id: string; name: string; created_at: string; disabled: number; last_login_at: string | null; user_key: string | null }>()
    return results.map(toUser)
  }

  async update(id: string, fields: Partial<Pick<User, "name" | "disabled" | "lastLoginAt" | "userKey">>): Promise<void> {
    const sets: string[] = []
    const binds: unknown[] = []
    if (fields.name !== undefined) { sets.push("name = ?"); binds.push(fields.name) }
    if (fields.disabled !== undefined) { sets.push("disabled = ?"); binds.push(fields.disabled ? 1 : 0) }
    if (fields.lastLoginAt !== undefined) { sets.push("last_login_at = ?"); binds.push(fields.lastLoginAt) }
    if (fields.userKey !== undefined) { sets.push("user_key = ?"); binds.push(fields.userKey) }
    if (sets.length === 0) return
    binds.push(id)
    await this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run()
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM users WHERE id = ?").bind(id).run()
  }
}

function toUser(row: { id: string; name: string; created_at: string; disabled: number; last_login_at: string | null; user_key?: string | null }): User {
  return { id: row.id, name: row.name, createdAt: row.created_at, disabled: row.disabled === 1, lastLoginAt: row.last_login_at ?? undefined, userKey: row.user_key ?? undefined }
}

class D1InviteCodeRepo implements InviteCodeRepo {
  constructor(private db: D1Database) {}

  async create(code: InviteCode): Promise<void> {
    await this.db
      .prepare("INSERT INTO invite_codes (id, code, name, created_at, used_at, used_by) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(code.id, code.code, code.name, code.createdAt, code.usedAt ?? null, code.usedBy ?? null)
      .run()
  }

  async findByCode(code: string): Promise<InviteCode | null> {
    const row = await this.db
      .prepare("SELECT id, code, name, created_at, used_at, used_by FROM invite_codes WHERE code = ?")
      .bind(code)
      .first<{ id: string; code: string; name: string; created_at: string; used_at: string | null; used_by: string | null }>()
    return row ? toInviteCode(row) : null
  }

  async list(): Promise<InviteCode[]> {
    const { results } = await this.db
      .prepare("SELECT id, code, name, created_at, used_at, used_by FROM invite_codes ORDER BY created_at DESC")
      .all<{ id: string; code: string; name: string; created_at: string; used_at: string | null; used_by: string | null }>()
    return results.map(toInviteCode)
  }

  async markUsed(id: string, userId: string): Promise<void> {
    await this.db
      .prepare("UPDATE invite_codes SET used_at = ?, used_by = ? WHERE id = ?")
      .bind(new Date().toISOString(), userId, id)
      .run()
  }

  async clearUsedBy(userId: string): Promise<void> {
    await this.db.prepare("UPDATE invite_codes SET used_by = NULL WHERE used_by = ?").bind(userId).run()
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM invite_codes WHERE id = ?").bind(id).run()
  }
}

function toInviteCode(row: { id: string; code: string; name: string; created_at: string; used_at: string | null; used_by: string | null }): InviteCode {
  return { id: row.id, code: row.code, name: row.name, createdAt: row.created_at, usedAt: row.used_at ?? undefined, usedBy: row.used_by ?? undefined }
}

class D1SessionRepo implements SessionRepo {
  constructor(private db: D1Database) {}

  async create(session: UserSession): Promise<void> {
    await this.db
      .prepare("INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(session.token, session.userId, session.createdAt, session.expiresAt)
      .run()
  }

  async findByToken(token: string): Promise<UserSession | null> {
    const row = await this.db
      .prepare("SELECT token, user_id, created_at, expires_at FROM user_sessions WHERE token = ?")
      .bind(token)
      .first<{ token: string; user_id: string; created_at: string; expires_at: string }>()
    return row ? { token: row.token, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at } : null
  }

  async deleteByUserId(userId: string): Promise<void> {
    await this.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").bind(userId).run()
  }

  async deleteExpired(): Promise<void> {
    await this.db.prepare("DELETE FROM user_sessions WHERE expires_at < ?").bind(new Date().toISOString()).run()
  }
}

// D1 stub for client presence — not used in Cloudflare Workers mode yet
class D1ClientPresenceRepo implements ClientPresenceRepo {
  constructor(private db: D1Database) {}
  async upsert(_p: ClientPresence): Promise<void> {}
  async list(): Promise<ClientPresence[]> { return [] }
  async listByOwner(_ownerId: string): Promise<ClientPresence[]> { return [] }
  async listByKeyIds(_keyIds: string[]): Promise<ClientPresence[]> { return [] }
  async pruneStale(_olderThanMinutes: number): Promise<void> {}
}

export class D1Repo implements Repo {
  apiKeys: ApiKeyRepo
  github: GitHubRepo
  usage: UsageRepo
  cache: CacheRepo
  latency: LatencyRepo
  users: UserRepo
  inviteCodes: InviteCodeRepo
  sessions: SessionRepo
  presence: ClientPresenceRepo

  constructor(db: D1Database) {
    this.apiKeys = new D1ApiKeyRepo(db)
    this.github = new D1GitHubRepo(db)
    this.usage = new D1UsageRepo(db)
    this.cache = new D1CacheRepo(db)
    this.latency = new D1LatencyRepo(db)
    this.users = new D1UserRepo(db)
    this.inviteCodes = new D1InviteCodeRepo(db)
    this.sessions = new D1SessionRepo(db)
    this.presence = new D1ClientPresenceRepo(db)
  }
}
