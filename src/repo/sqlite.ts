import { Database } from "bun:sqlite"
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
  InviteCode,
  InviteCodeRepo,
  KeyAssignment,
  KeyAssignmentRepo,
  LatencyRecord,
  LatencyRepo,
  ObservabilityShare,
  ObservabilityShareRepo,
  Repo,
  SessionRepo,
  UsageRecord,
  UsageRepo,
  User,
  UserRepo,
  UserSession,
  WebSearchUsageRecord,
  WebSearchUsageRepo,
} from "./types"

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  owner_id TEXT
);

CREATE TABLE IF NOT EXISTS github_accounts (
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'individual',
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  owner_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, owner_id)
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  hour TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, model, hour, client)
);

CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage (hour);

CREATE TABLE IF NOT EXISTS latency (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  hour TEXT NOT NULL,
  colo TEXT NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL DEFAULT 0,
  upstream_ms INTEGER NOT NULL DEFAULT 0,
  ttfb_ms INTEGER NOT NULL DEFAULT 0,
  token_miss INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, model, hour, colo, stream)
);

CREATE INDEX IF NOT EXISTS idx_latency_hour ON latency (hour);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  user_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_presence (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  key_id TEXT,
  key_name TEXT,
  owner_id TEXT,
  gateway_url TEXT,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_search_usage (
  key_id TEXT NOT NULL,
  hour TEXT NOT NULL,
  searches INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, hour)
);
`

class SqliteApiKeyRepo implements ApiKeyRepo {
  constructor(private db: Database) {}

  private static readonly SELECT_COLS = "id, name, key, created_at, last_used_at, owner_id, quota_requests_per_day, quota_tokens_per_day, web_search_enabled, web_search_bing_enabled, web_search_langsearch_key, web_search_tavily_key, web_search_copilot_enabled, web_search_copilot_priority"

  async list(): Promise<ApiKey[]> {
    return this.db.query<any, []>(`SELECT ${SqliteApiKeyRepo.SELECT_COLS} FROM api_keys ORDER BY created_at`).all().map(toApiKey)
  }

  async listByOwner(ownerId: string): Promise<ApiKey[]> {
    return this.db.query<any, [string]>(`SELECT ${SqliteApiKeyRepo.SELECT_COLS} FROM api_keys WHERE owner_id = ? ORDER BY created_at`).all(ownerId).map(toApiKey)
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const row = this.db.query<any, [string]>(`SELECT ${SqliteApiKeyRepo.SELECT_COLS} FROM api_keys WHERE key = ?`).get(rawKey)
    return row ? toApiKey(row) : null
  }

  async getById(id: string): Promise<ApiKey | null> {
    const row = this.db.query<any, [string]>(`SELECT ${SqliteApiKeyRepo.SELECT_COLS} FROM api_keys WHERE id = ?`).get(id)
    return row ? toApiKey(row) : null
  }

  async save(key: ApiKey): Promise<void> {
    this.db.query(
      `INSERT INTO api_keys (id, name, key, created_at, last_used_at, owner_id, quota_requests_per_day, quota_tokens_per_day, web_search_enabled, web_search_bing_enabled, web_search_langsearch_key, web_search_tavily_key, web_search_copilot_enabled, web_search_copilot_priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, key = excluded.key, last_used_at = excluded.last_used_at, owner_id = excluded.owner_id, quota_requests_per_day = excluded.quota_requests_per_day, quota_tokens_per_day = excluded.quota_tokens_per_day, web_search_enabled = excluded.web_search_enabled, web_search_bing_enabled = excluded.web_search_bing_enabled, web_search_langsearch_key = excluded.web_search_langsearch_key, web_search_tavily_key = excluded.web_search_tavily_key, web_search_copilot_enabled = excluded.web_search_copilot_enabled, web_search_copilot_priority = excluded.web_search_copilot_priority`,
    ).run(key.id, key.name, key.key, key.createdAt, key.lastUsedAt ?? null, key.ownerId ?? null, key.quotaRequestsPerDay ?? null, key.quotaTokensPerDay ?? null, key.webSearchEnabled ? 1 : 0, key.webSearchBingEnabled ? 1 : 0, key.webSearchLangsearchKey ?? null, key.webSearchTavilyKey ?? null, key.webSearchCopilotEnabled ? 1 : 0, key.webSearchCopilotPriority ? 1 : 0)
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.query("DELETE FROM api_keys WHERE id = ?").run(id)
    return result.changes > 0
  }

  async deleteAll(): Promise<void> {
    this.db.query("DELETE FROM api_keys").run()
  }
}

function toApiKey(row: any): ApiKey {
  return { id: row.id, name: row.name, key: row.key, createdAt: row.created_at, lastUsedAt: row.last_used_at ?? undefined, ownerId: row.owner_id ?? undefined, quotaRequestsPerDay: row.quota_requests_per_day ?? undefined, quotaTokensPerDay: row.quota_tokens_per_day ?? undefined, webSearchEnabled: row.web_search_enabled === 1, webSearchBingEnabled: row.web_search_bing_enabled === 1, webSearchLangsearchKey: row.web_search_langsearch_key ?? undefined, webSearchTavilyKey: row.web_search_tavily_key ?? undefined, webSearchCopilotEnabled: row.web_search_copilot_enabled === 1, webSearchCopilotPriority: row.web_search_copilot_priority === 1 }
}

class SqliteGitHubRepo implements GitHubRepo {
  constructor(private db: Database) {}

  async listAccounts(): Promise<GitHubAccount[]> {
    return this.db.query<any, []>("SELECT user_id, token, account_type, login, name, avatar_url, owner_id FROM github_accounts").all().map(toGitHubAccount)
  }

  async listAccountsByOwner(ownerId: string): Promise<GitHubAccount[]> {
    return this.db.query<any, [string]>("SELECT user_id, token, account_type, login, name, avatar_url, owner_id FROM github_accounts WHERE owner_id = ?").all(ownerId).map(toGitHubAccount)
  }

  async getAccount(userId: number, ownerId?: string): Promise<GitHubAccount | null> {
    const ownerVal = ownerId ?? ""
    const row = this.db.query<any, [number, string]>("SELECT user_id, token, account_type, login, name, avatar_url, owner_id FROM github_accounts WHERE user_id = ? AND owner_id = ?").get(userId, ownerVal)
    return row ? toGitHubAccount(row) : null
  }

  async saveAccount(userId: number, account: GitHubAccount): Promise<void> {
    const ownerId = account.ownerId ?? ""
    this.db.query(
      `INSERT INTO github_accounts (user_id, token, account_type, login, name, avatar_url, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, owner_id) DO UPDATE SET token = excluded.token, account_type = excluded.account_type, login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url`,
    ).run(userId, account.token, account.accountType, account.user.login, account.user.name, account.user.avatar_url, ownerId)
  }

  async deleteAccount(userId: number, ownerId?: string): Promise<void> {
    if (ownerId !== undefined) {
      this.db.query("DELETE FROM github_accounts WHERE user_id = ? AND owner_id = ?").run(userId, ownerId)
    } else {
      this.db.query("DELETE FROM github_accounts WHERE user_id = ?").run(userId)
    }
  }

  async deleteAllAccounts(): Promise<void> {
    this.db.query("DELETE FROM github_accounts").run()
    await this.clearActiveId()
  }

  async getActiveId(): Promise<number | null> {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM config WHERE key = ?").get("active_github_account")
    return row ? Number(row.value) : null
  }

  async setActiveId(userId: number): Promise<void> {
    this.db.query("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run("active_github_account", String(userId))
  }

  async clearActiveId(): Promise<void> {
    this.db.query("DELETE FROM config WHERE key = ?").run("active_github_account")
  }

  async getActiveIdForUser(ownerId: string): Promise<number | null> {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM config WHERE key = ?").get(`active_github_account:${ownerId}`)
    return row ? Number(row.value) : null
  }

  async setActiveIdForUser(ownerId: string, userId: number): Promise<void> {
    this.db.query("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(`active_github_account:${ownerId}`, String(userId))
  }

  async clearActiveIdForUser(ownerId: string): Promise<void> {
    this.db.query("DELETE FROM config WHERE key = ?").run(`active_github_account:${ownerId}`)
  }
}

function toGitHubAccount(row: any): GitHubAccount {
  return {
    token: row.token,
    accountType: row.account_type,
    ownerId: row.owner_id ?? undefined,
    user: { id: row.user_id, login: row.login, name: row.name, avatar_url: row.avatar_url },
  }
}

class SqliteUsageRepo implements UsageRepo {
  constructor(private db: Database) {}

  async record(keyId: string, model: string, hour: string, requests: number, inputTokens: number, outputTokens: number, client?: string, cacheReadTokens?: number, cacheCreationTokens?: number): Promise<void> {
    const c = client || ""
    this.db.query(
      `INSERT INTO usage (key_id, model, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_id, model, hour, client) DO UPDATE SET requests = requests + excluded.requests, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens`,
    ).run(keyId, model, hour, c, requests, inputTokens, outputTokens, cacheReadTokens ?? 0, cacheCreationTokens ?? 0)
  }

  async query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<UsageRecord[]> {
    let rows: any[]
    if (opts.keyIds && opts.keyIds.length > 0) {
      const placeholders = opts.keyIds.map(() => "?").join(",")
      rows = this.db.query(`SELECT key_id, model, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage WHERE key_id IN (${placeholders}) AND hour >= ? AND hour < ? ORDER BY hour`).all(...opts.keyIds, opts.start, opts.end)
    } else if (opts.keyId) {
      rows = this.db.query("SELECT key_id, model, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage WHERE key_id = ? AND hour >= ? AND hour < ? ORDER BY hour").all(opts.keyId, opts.start, opts.end)
    } else {
      rows = this.db.query("SELECT key_id, model, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage WHERE hour >= ? AND hour < ? ORDER BY hour").all(opts.start, opts.end)
    }
    return rows.map((r: any) => ({ keyId: r.key_id, model: r.model, hour: r.hour, client: r.client || "", requests: r.requests, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens ?? 0, cacheCreationTokens: r.cache_creation_tokens ?? 0 }))
  }

  async listAll(): Promise<UsageRecord[]> {
    return this.db.query<any, []>("SELECT key_id, model, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage ORDER BY hour").all()
      .map((r: any) => ({ keyId: r.key_id, model: r.model, hour: r.hour, client: r.client || "", requests: r.requests, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens ?? 0, cacheCreationTokens: r.cache_creation_tokens ?? 0 }))
  }

  async set(record: UsageRecord): Promise<void> {
    const c = record.client || ""
    this.db.query(
      `INSERT INTO usage (key_id, model, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_id, model, hour, client) DO UPDATE SET requests = excluded.requests, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens, cache_creation_tokens = excluded.cache_creation_tokens`,
    ).run(record.keyId, record.model, record.hour, c, record.requests, record.inputTokens, record.outputTokens, record.cacheReadTokens ?? 0, record.cacheCreationTokens ?? 0)
  }

  async deleteAll(): Promise<void> {
    this.db.query("DELETE FROM usage").run()
  }
}

class SqliteCacheRepo implements CacheRepo {
  constructor(private db: Database) {}

  async get(key: string): Promise<string | null> {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM config WHERE key = ?").get(key)
    return row?.value ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.db.query("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value)
  }

  async delete(key: string): Promise<void> {
    this.db.query("DELETE FROM config WHERE key = ?").run(key)
  }
}

class SqliteLatencyRepo implements LatencyRepo {
  constructor(private db: Database) {}

  async record(entry: { keyId: string; model: string; hour: string; colo: string; stream: boolean; totalMs: number; upstreamMs: number; ttfbMs: number; tokenMiss: boolean }): Promise<void> {
    this.db.query(
      `INSERT INTO latency (key_id, model, hour, colo, stream, requests, total_ms, upstream_ms, ttfb_ms, token_miss) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT (key_id, model, hour, colo, stream) DO UPDATE SET requests = requests + 1, total_ms = total_ms + excluded.total_ms, upstream_ms = upstream_ms + excluded.upstream_ms, ttfb_ms = ttfb_ms + excluded.ttfb_ms, token_miss = token_miss + excluded.token_miss`,
    ).run(entry.keyId, entry.model, entry.hour, entry.colo, entry.stream ? 1 : 0, entry.totalMs, entry.upstreamMs, entry.ttfbMs, entry.tokenMiss ? 1 : 0)
  }

  async query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<LatencyRecord[]> {
    let rows: any[]
    if (opts.keyIds && opts.keyIds.length > 0) {
      const placeholders = opts.keyIds.map(() => "?").join(",")
      rows = this.db.query(`SELECT key_id, model, hour, colo, stream, requests, total_ms, upstream_ms, ttfb_ms, token_miss FROM latency WHERE key_id IN (${placeholders}) AND hour >= ? AND hour < ? ORDER BY hour`).all(...opts.keyIds, opts.start, opts.end)
    } else if (opts.keyId) {
      rows = this.db.query("SELECT key_id, model, hour, colo, stream, requests, total_ms, upstream_ms, ttfb_ms, token_miss FROM latency WHERE key_id = ? AND hour >= ? AND hour < ? ORDER BY hour").all(opts.keyId, opts.start, opts.end)
    } else {
      rows = this.db.query("SELECT key_id, model, hour, colo, stream, requests, total_ms, upstream_ms, ttfb_ms, token_miss FROM latency WHERE hour >= ? AND hour < ? ORDER BY hour").all(opts.start, opts.end)
    }
    return rows.map((r: any) => ({ keyId: r.key_id, model: r.model, hour: r.hour, colo: r.colo, stream: r.stream === 1, requests: r.requests, totalMs: r.total_ms, upstreamMs: r.upstream_ms, ttfbMs: r.ttfb_ms, tokenMiss: r.token_miss }))
  }

  async deleteAll(): Promise<void> {
    this.db.query("DELETE FROM latency").run()
  }
}

class SqliteUserRepo implements UserRepo {
  constructor(private db: Database) {}

  async create(user: User): Promise<void> {
    this.db.query("INSERT INTO users (id, name, email, avatar_url, created_at, disabled, last_login_at, user_key, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(user.id, user.name, user.email ?? null, user.avatarUrl ?? null, user.createdAt, user.disabled ? 1 : 0, user.lastLoginAt ?? null, user.userKey ?? null, user.passwordHash ?? null)
  }

  async getById(id: string): Promise<User | null> {
    const row = this.db.query<any, [string]>("SELECT id, name, email, avatar_url, created_at, disabled, last_login_at, user_key, password_hash FROM users WHERE id = ?").get(id)
    return row ? { id: row.id, name: row.name, email: row.email ?? undefined, avatarUrl: row.avatar_url ?? undefined, createdAt: row.created_at, disabled: row.disabled === 1, lastLoginAt: row.last_login_at ?? undefined, userKey: row.user_key ?? undefined, passwordHash: row.password_hash ?? undefined } : null
  }

  async findByKey(userKey: string): Promise<User | null> {
    const row = this.db.query<any, [string]>("SELECT id, name, email, avatar_url, created_at, disabled, last_login_at, user_key, password_hash FROM users WHERE user_key = ?").get(userKey)
    return row ? { id: row.id, name: row.name, email: row.email ?? undefined, avatarUrl: row.avatar_url ?? undefined, createdAt: row.created_at, disabled: row.disabled === 1, lastLoginAt: row.last_login_at ?? undefined, userKey: row.user_key ?? undefined, passwordHash: row.password_hash ?? undefined } : null
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = this.db.query<any, [string]>("SELECT id, name, email, avatar_url, created_at, disabled, last_login_at, user_key, password_hash FROM users WHERE email = ?").get(email)
    return row ? { id: row.id, name: row.name, email: row.email ?? undefined, avatarUrl: row.avatar_url ?? undefined, createdAt: row.created_at, disabled: row.disabled === 1, lastLoginAt: row.last_login_at ?? undefined, userKey: row.user_key ?? undefined, passwordHash: row.password_hash ?? undefined } : null
  }

  async list(): Promise<User[]> {
    return this.db.query<any, []>("SELECT id, name, email, avatar_url, created_at, disabled, last_login_at, user_key, password_hash FROM users ORDER BY created_at").all()
      .map((r: any) => ({ id: r.id, name: r.name, email: r.email ?? undefined, avatarUrl: r.avatar_url ?? undefined, createdAt: r.created_at, disabled: r.disabled === 1, lastLoginAt: r.last_login_at ?? undefined, userKey: r.user_key ?? undefined, passwordHash: r.password_hash ?? undefined }))
  }

  async update(id: string, fields: Partial<Pick<User, "name" | "email" | "avatarUrl" | "disabled" | "lastLoginAt" | "userKey" | "passwordHash">>): Promise<void> {
    const sets: string[] = []
    const binds: any[] = []
    if (fields.name !== undefined) { sets.push("name = ?"); binds.push(fields.name) }
    if (fields.email !== undefined) { sets.push("email = ?"); binds.push(fields.email) }
    if (fields.avatarUrl !== undefined) { sets.push("avatar_url = ?"); binds.push(fields.avatarUrl) }
    if (fields.disabled !== undefined) { sets.push("disabled = ?"); binds.push(fields.disabled ? 1 : 0) }
    if (fields.lastLoginAt !== undefined) { sets.push("last_login_at = ?"); binds.push(fields.lastLoginAt) }
    if (fields.userKey !== undefined) { sets.push("user_key = ?"); binds.push(fields.userKey) }
    if (fields.passwordHash !== undefined) { sets.push("password_hash = ?"); binds.push(fields.passwordHash) }
    if (sets.length === 0) return
    binds.push(id)
    this.db.query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...binds)
  }

  async delete(id: string): Promise<void> {
    this.db.query("DELETE FROM users WHERE id = ?").run(id)
  }
}

class SqliteInviteCodeRepo implements InviteCodeRepo {
  constructor(private db: Database) {}

  async create(code: InviteCode): Promise<void> {
    this.db.query("INSERT INTO invite_codes (id, code, name, email, created_at, used_at, used_by) VALUES (?, ?, ?, ?, ?, ?, ?)").run(code.id, code.code, code.name, code.email ?? null, code.createdAt, code.usedAt ?? null, code.usedBy ?? null)
  }

  async findByCode(code: string): Promise<InviteCode | null> {
    const row = this.db.query<any, [string]>("SELECT id, code, name, email, created_at, used_at, used_by FROM invite_codes WHERE code = ?").get(code)
    return row ? { id: row.id, code: row.code, name: row.name, email: row.email ?? undefined, createdAt: row.created_at, usedAt: row.used_at ?? undefined, usedBy: row.used_by ?? undefined } : null
  }

  async list(): Promise<InviteCode[]> {
    return this.db.query<any, []>("SELECT id, code, name, email, created_at, used_at, used_by FROM invite_codes ORDER BY created_at DESC").all()
      .map((r: any) => ({ id: r.id, code: r.code, name: r.name, email: r.email ?? undefined, createdAt: r.created_at, usedAt: r.used_at ?? undefined, usedBy: r.used_by ?? undefined }))
  }

  async markUsed(id: string, userId: string): Promise<void> {
    this.db.query("UPDATE invite_codes SET used_at = ?, used_by = ? WHERE id = ?").run(new Date().toISOString(), userId, id)
  }

  async clearUsedBy(userId: string): Promise<void> {
    this.db.query("UPDATE invite_codes SET used_by = NULL WHERE used_by = ?").run(userId)
  }

  async delete(id: string): Promise<void> {
    this.db.query("DELETE FROM invite_codes WHERE id = ?").run(id)
  }
}

class SqliteSessionRepo implements SessionRepo {
  constructor(private db: Database) {}

  async create(session: UserSession): Promise<void> {
    this.db.query("INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(session.token, session.userId, session.createdAt, session.expiresAt)
  }

  async findByToken(token: string): Promise<UserSession | null> {
    const row = this.db.query<any, [string]>("SELECT token, user_id, created_at, expires_at FROM user_sessions WHERE token = ?").get(token)
    return row ? { token: row.token, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at } : null
  }

  async deleteByUserId(userId: string): Promise<void> {
    this.db.query("DELETE FROM user_sessions WHERE user_id = ?").run(userId)
  }

  async deleteExpired(): Promise<void> {
    this.db.query("DELETE FROM user_sessions WHERE expires_at < ?").run(new Date().toISOString())
  }
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query<{ name: string }, [string, string]>("SELECT name FROM pragma_table_info(?) WHERE name = ?").all(table, column)
  return rows.length > 0
}

function migrateSchema(db: Database): void {
  // Add owner_id to github_accounts (multi-user isolation)
  if (!hasColumn(db, "github_accounts", "owner_id")) {
    db.exec("ALTER TABLE github_accounts ADD COLUMN owner_id TEXT")
  }
  // Add owner_id to api_keys (multi-user isolation)
  if (!hasColumn(db, "api_keys", "owner_id")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN owner_id TEXT")
  }
  // Rebuild latency table if PK does NOT include 'stream' column (needs stream for separate tracking)
  if (!hasColumn(db, "latency", "stream")) {
    db.exec(`
      ALTER TABLE latency RENAME TO latency_old;
      CREATE TABLE latency (
        key_id TEXT NOT NULL,
        model TEXT NOT NULL,
        hour TEXT NOT NULL,
        colo TEXT NOT NULL,
        stream INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        total_ms INTEGER NOT NULL DEFAULT 0,
        upstream_ms INTEGER NOT NULL DEFAULT 0,
        ttfb_ms INTEGER NOT NULL DEFAULT 0,
        token_miss INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, model, hour, colo, stream)
      );
      INSERT INTO latency (key_id, model, hour, colo, stream, requests, total_ms, upstream_ms, ttfb_ms, token_miss)
        SELECT key_id, model, hour, colo, 0, requests, total_ms, upstream_ms, ttfb_ms, token_miss
        FROM latency_old;
      DROP TABLE latency_old;
      CREATE INDEX IF NOT EXISTS idx_latency_hour ON latency (hour);
    `)
  }
  // Add user_key to users table
  if (!hasColumn(db, "users", "user_key")) {
    db.exec("ALTER TABLE users ADD COLUMN user_key TEXT")
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_key ON users(user_key)")
  }
  // Migrate github_accounts to composite PK (user_id, owner_id)
  const pkInfo = db.query<{ name: string }, []>("PRAGMA table_info(github_accounts)").all()
  const ownerCol = pkInfo.find(c => c.name === "owner_id")
  // If owner_id column is missing pk flag or allows NULL, rebuild with composite PK
  if (ownerCol && (ownerCol as any).pk === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS github_accounts_new (
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'individual',
        login TEXT NOT NULL,
        name TEXT,
        avatar_url TEXT,
        owner_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (user_id, owner_id)
      );
      INSERT OR IGNORE INTO github_accounts_new (user_id, token, account_type, login, name, avatar_url, owner_id)
        SELECT user_id, token, account_type, login, name, avatar_url, COALESCE(owner_id, '')
        FROM github_accounts;
      DROP TABLE github_accounts;
      ALTER TABLE github_accounts_new RENAME TO github_accounts;
    `)
  }
  // Migrate usage table to include client column in PK
  if (!hasColumn(db, "usage", "client")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_new (
        key_id TEXT NOT NULL,
        model TEXT NOT NULL,
        hour TEXT NOT NULL,
        client TEXT NOT NULL DEFAULT '',
        requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, model, hour, client)
      );
      INSERT OR IGNORE INTO usage_new (key_id, model, hour, client, requests, input_tokens, output_tokens)
        SELECT key_id, model, hour, '', requests, input_tokens, output_tokens
        FROM usage;
      DROP TABLE usage;
      ALTER TABLE usage_new RENAME TO usage;
      CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage (hour);
    `)
  }
  // Add cache token columns to usage table
  if (!hasColumn(db, "usage", "cache_read_tokens")) {
    db.exec("ALTER TABLE usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0")
  }
  if (!hasColumn(db, "usage", "cache_creation_tokens")) {
    db.exec("ALTER TABLE usage ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0")
  }
  // Add quota columns to api_keys
  if (!hasColumn(db, "api_keys", "quota_requests_per_day")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN quota_requests_per_day INTEGER")
  }
  if (!hasColumn(db, "api_keys", "quota_tokens_per_day")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN quota_tokens_per_day INTEGER")
  }
  // Add web search columns to api_keys
  if (!hasColumn(db, "api_keys", "web_search_enabled")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_enabled INTEGER DEFAULT 0")
  }
  if (!hasColumn(db, "api_keys", "web_search_bing_enabled")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_bing_enabled INTEGER DEFAULT 0")
  }
  if (!hasColumn(db, "api_keys", "web_search_langsearch_key")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_langsearch_key TEXT")
  }
  if (!hasColumn(db, "api_keys", "web_search_tavily_key")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_tavily_key TEXT")
  }
  if (!hasColumn(db, "api_keys", "web_search_copilot_enabled")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_copilot_enabled INTEGER DEFAULT 0")
  }
  if (!hasColumn(db, "api_keys", "web_search_copilot_priority")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_copilot_priority INTEGER DEFAULT 0")
  }
  // Add email to users
  if (!hasColumn(db, "users", "email")) {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT")
    db.exec("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)")
  }
  // Add avatar_url to users
  if (!hasColumn(db, "users", "avatar_url")) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT")
  }
  // Add password_hash to users
  if (!hasColumn(db, "users", "password_hash")) {
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT")
  }
  // Add email to invite_codes (record which email was used to register)
  if (!hasColumn(db, "invite_codes", "email")) {
    db.exec("ALTER TABLE invite_codes ADD COLUMN email TEXT")
  }
  // Key assignments table
  db.exec(`CREATE TABLE IF NOT EXISTS key_assignments (
    key_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    assigned_by TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    PRIMARY KEY (key_id, user_id)
  )`)
  // Observability shares table
  db.exec(`CREATE TABLE IF NOT EXISTS observability_shares (
    owner_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, viewer_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_observability_shares_viewer ON observability_shares(viewer_id)`)
  // Device codes table
  db.exec(`CREATE TABLE IF NOT EXISTS device_codes (
    device_code TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    user_id TEXT,
    session_token TEXT,
    created_at TEXT NOT NULL
  )`)
}

class SqliteClientPresenceRepo implements ClientPresenceRepo {
  constructor(private db: Database) {}

  async upsert(p: ClientPresence): Promise<void> {
    this.db.query(
      `INSERT INTO client_presence (client_id, client_name, key_id, key_name, owner_id, gateway_url, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (client_id) DO UPDATE SET
         client_name = excluded.client_name,
         key_id = excluded.key_id,
         key_name = excluded.key_name,
         owner_id = excluded.owner_id,
         gateway_url = excluded.gateway_url,
         last_seen_at = excluded.last_seen_at`,
    ).run(p.clientId, p.clientName, p.keyId ?? null, p.keyName ?? null, p.ownerId ?? null, p.gatewayUrl ?? null, p.lastSeenAt)
  }

  async list(): Promise<ClientPresence[]> {
    return this.db.query<any, []>("SELECT client_id, client_name, key_id, key_name, owner_id, gateway_url, last_seen_at FROM client_presence ORDER BY last_seen_at DESC").all().map(toPresence)
  }

  async listByOwner(ownerId: string): Promise<ClientPresence[]> {
    return this.db.query<any, [string]>("SELECT client_id, client_name, key_id, key_name, owner_id, gateway_url, last_seen_at FROM client_presence WHERE owner_id = ? ORDER BY last_seen_at DESC").all(ownerId).map(toPresence)
  }

  async listByKeyIds(keyIds: string[]): Promise<ClientPresence[]> {
    if (keyIds.length === 0) return []
    const placeholders = keyIds.map(() => "?").join(",")
    return this.db.query<any, string[]>(`SELECT client_id, client_name, key_id, key_name, owner_id, gateway_url, last_seen_at FROM client_presence WHERE key_id IN (${placeholders}) ORDER BY last_seen_at DESC`).all(...keyIds).map(toPresence)
  }

  async pruneStale(olderThanMinutes: number): Promise<void> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString()
    this.db.query("DELETE FROM client_presence WHERE last_seen_at < ?").run(cutoff)
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

class SqliteWebSearchUsageRepo implements WebSearchUsageRepo {
  constructor(private db: Database) {}

  async record(keyId: string, hour: string, success: boolean): Promise<void> {
    if (success) {
      this.db.query(
        `INSERT INTO web_search_usage (key_id, hour, searches, successes, failures) VALUES (?, ?, 1, 1, 0)
         ON CONFLICT (key_id, hour) DO UPDATE SET searches = searches + 1, successes = successes + 1`,
      ).run(keyId, hour)
    } else {
      this.db.query(
        `INSERT INTO web_search_usage (key_id, hour, searches, successes, failures) VALUES (?, ?, 1, 0, 1)
         ON CONFLICT (key_id, hour) DO UPDATE SET searches = searches + 1, failures = failures + 1`,
      ).run(keyId, hour)
    }
  }

  async query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<WebSearchUsageRecord[]> {
    let rows: any[]
    if (opts.keyIds && opts.keyIds.length > 0) {
      const placeholders = opts.keyIds.map(() => "?").join(",")
      rows = this.db.query(`SELECT key_id, hour, searches, successes, failures FROM web_search_usage WHERE key_id IN (${placeholders}) AND hour >= ? AND hour < ? ORDER BY hour`).all(...opts.keyIds, opts.start, opts.end)
    } else if (opts.keyId) {
      rows = this.db.query("SELECT key_id, hour, searches, successes, failures FROM web_search_usage WHERE key_id = ? AND hour >= ? AND hour < ? ORDER BY hour").all(opts.keyId, opts.start, opts.end)
    } else {
      rows = this.db.query("SELECT key_id, hour, searches, successes, failures FROM web_search_usage WHERE hour >= ? AND hour < ? ORDER BY hour").all(opts.start, opts.end)
    }
    return rows.map((r: any) => ({ keyId: r.key_id, hour: r.hour, searches: r.searches, successes: r.successes, failures: r.failures }))
  }

  async deleteAll(): Promise<void> {
    this.db.query("DELETE FROM web_search_usage").run()
  }
}

class SqliteKeyAssignmentRepo implements KeyAssignmentRepo {
  constructor(private db: Database) {}

  async assign(keyId: string, userId: string, assignedBy: string): Promise<void> {
    this.db.query("INSERT OR REPLACE INTO key_assignments (key_id, user_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)").run(keyId, userId, assignedBy, new Date().toISOString())
  }

  async unassign(keyId: string, userId: string): Promise<void> {
    this.db.query("DELETE FROM key_assignments WHERE key_id = ? AND user_id = ?").run(keyId, userId)
  }

  async listByUser(userId: string): Promise<KeyAssignment[]> {
    return this.db.query<any, [string]>("SELECT key_id, user_id, assigned_by, assigned_at FROM key_assignments WHERE user_id = ?").all(userId)
      .map((r: any) => ({ keyId: r.key_id, userId: r.user_id, assignedBy: r.assigned_by, assignedAt: r.assigned_at }))
  }

  async listByKey(keyId: string): Promise<KeyAssignment[]> {
    return this.db.query<any, [string]>("SELECT key_id, user_id, assigned_by, assigned_at FROM key_assignments WHERE key_id = ?").all(keyId)
      .map((r: any) => ({ keyId: r.key_id, userId: r.user_id, assignedBy: r.assigned_by, assignedAt: r.assigned_at }))
  }

  async deleteByKey(keyId: string): Promise<void> {
    this.db.query("DELETE FROM key_assignments WHERE key_id = ?").run(keyId)
  }

  async deleteByUser(userId: string): Promise<void> {
    this.db.query("DELETE FROM key_assignments WHERE user_id = ?").run(userId)
  }
}

class SqliteObservabilityShareRepo implements ObservabilityShareRepo {
  constructor(private db: Database) {}

  async share(ownerId: string, viewerId: string, grantedBy: string): Promise<void> {
    this.db.query(
      "INSERT OR REPLACE INTO observability_shares (owner_id, viewer_id, granted_by, granted_at) VALUES (?, ?, ?, ?)"
    ).run(ownerId, viewerId, grantedBy, new Date().toISOString())
  }

  async unshare(ownerId: string, viewerId: string): Promise<void> {
    this.db.query("DELETE FROM observability_shares WHERE owner_id = ? AND viewer_id = ?").run(ownerId, viewerId)
  }

  async listByOwner(ownerId: string): Promise<ObservabilityShare[]> {
    return this.db.query<any, [string]>(
      "SELECT owner_id, viewer_id, granted_by, granted_at FROM observability_shares WHERE owner_id = ?"
    ).all(ownerId).map((r: any) => ({
      ownerId: r.owner_id, viewerId: r.viewer_id, grantedBy: r.granted_by, grantedAt: r.granted_at,
    }))
  }

  async listByViewer(viewerId: string): Promise<ObservabilityShare[]> {
    return this.db.query<any, [string]>(
      "SELECT owner_id, viewer_id, granted_by, granted_at FROM observability_shares WHERE viewer_id = ?"
    ).all(viewerId).map((r: any) => ({
      ownerId: r.owner_id, viewerId: r.viewer_id, grantedBy: r.granted_by, grantedAt: r.granted_at,
    }))
  }

  async isGranted(ownerId: string, viewerId: string): Promise<boolean> {
    const row = this.db.query<any, [string, string]>(
      "SELECT 1 FROM observability_shares WHERE owner_id = ? AND viewer_id = ? LIMIT 1"
    ).get(ownerId, viewerId)
    return !!row
  }

  async deleteByOwner(ownerId: string): Promise<void> {
    this.db.query("DELETE FROM observability_shares WHERE owner_id = ?").run(ownerId)
  }

  async deleteByViewer(viewerId: string): Promise<void> {
    this.db.query("DELETE FROM observability_shares WHERE viewer_id = ?").run(viewerId)
  }
}

class SqliteDeviceCodeRepo implements DeviceCodeRepo {
  constructor(private db: Database) {}

  async create(code: DeviceCode): Promise<void> {
    this.db.query("INSERT INTO device_codes (device_code, user_code, expires_at, user_id, session_token, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(code.deviceCode, code.userCode, code.expiresAt, code.userId ?? null, code.sessionToken ?? null, code.createdAt)
  }

  async findByDeviceCode(deviceCode: string): Promise<DeviceCode | null> {
    const row = this.db.query<any, [string]>("SELECT device_code, user_code, expires_at, user_id, session_token, created_at FROM device_codes WHERE device_code = ?").get(deviceCode)
    return row ? toDeviceCodeSqlite(row) : null
  }

  async findByUserCode(userCode: string): Promise<DeviceCode | null> {
    const row = this.db.query<any, [string]>("SELECT device_code, user_code, expires_at, user_id, session_token, created_at FROM device_codes WHERE user_code = ?").get(userCode)
    return row ? toDeviceCodeSqlite(row) : null
  }

  async verify(deviceCode: string, userId: string, sessionToken: string): Promise<void> {
    this.db.query("UPDATE device_codes SET user_id = ?, session_token = ? WHERE device_code = ?").run(userId, sessionToken, deviceCode)
  }

  async deleteExpired(): Promise<void> {
    this.db.query("DELETE FROM device_codes WHERE expires_at < ?").run(new Date().toISOString())
  }

  async delete(deviceCode: string): Promise<void> {
    this.db.query("DELETE FROM device_codes WHERE device_code = ?").run(deviceCode)
  }
}

function toDeviceCodeSqlite(row: any): DeviceCode {
  return {
    deviceCode: row.device_code,
    userCode: row.user_code,
    expiresAt: row.expires_at,
    userId: row.user_id ?? undefined,
    sessionToken: row.session_token ?? undefined,
    createdAt: row.created_at,
  }
}

export class SqliteRepo implements Repo {
  apiKeys: ApiKeyRepo
  github: GitHubRepo
  usage: UsageRepo
  cache: CacheRepo
  latency: LatencyRepo
  users: UserRepo
  inviteCodes: InviteCodeRepo
  sessions: SessionRepo
  presence: ClientPresenceRepo
  webSearchUsage: WebSearchUsageRepo
  keyAssignments: KeyAssignmentRepo
  deviceCodes: DeviceCodeRepo
  observabilityShares: ObservabilityShareRepo

  constructor(db: Database) {
    db.exec(INIT_SQL)
    migrateSchema(db)
    this.apiKeys = new SqliteApiKeyRepo(db)
    this.github = new SqliteGitHubRepo(db)
    this.usage = new SqliteUsageRepo(db)
    this.cache = new SqliteCacheRepo(db)
    this.latency = new SqliteLatencyRepo(db)
    this.users = new SqliteUserRepo(db)
    this.inviteCodes = new SqliteInviteCodeRepo(db)
    this.sessions = new SqliteSessionRepo(db)
    this.presence = new SqliteClientPresenceRepo(db)
    this.webSearchUsage = new SqliteWebSearchUsageRepo(db)
    this.keyAssignments = new SqliteKeyAssignmentRepo(db)
    this.deviceCodes = new SqliteDeviceCodeRepo(db)
    this.observabilityShares = new SqliteObservabilityShareRepo(db)
  }
}

export function createSqliteDb(path: string): Database {
  return new Database(path)
}
