import { Database } from "bun:sqlite"
import type {
  ApiKey,
  ApiKeyRepo,
  CacheRepo,
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
`

class SqliteApiKeyRepo implements ApiKeyRepo {
  constructor(private db: Database) {}

  async list(): Promise<ApiKey[]> {
    return this.db.query<any, []>("SELECT id, name, key, created_at, last_used_at, owner_id FROM api_keys ORDER BY created_at").all().map(toApiKey)
  }

  async listByOwner(ownerId: string): Promise<ApiKey[]> {
    return this.db.query<any, [string]>("SELECT id, name, key, created_at, last_used_at, owner_id FROM api_keys WHERE owner_id = ? ORDER BY created_at").all(ownerId).map(toApiKey)
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const row = this.db.query<any, [string]>("SELECT id, name, key, created_at, last_used_at, owner_id FROM api_keys WHERE key = ?").get(rawKey)
    return row ? toApiKey(row) : null
  }

  async getById(id: string): Promise<ApiKey | null> {
    const row = this.db.query<any, [string]>("SELECT id, name, key, created_at, last_used_at, owner_id FROM api_keys WHERE id = ?").get(id)
    return row ? toApiKey(row) : null
  }

  async save(key: ApiKey): Promise<void> {
    this.db.query(
      `INSERT INTO api_keys (id, name, key, created_at, last_used_at, owner_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, key = excluded.key, last_used_at = excluded.last_used_at, owner_id = excluded.owner_id`,
    ).run(key.id, key.name, key.key, key.createdAt, key.lastUsedAt ?? null, key.ownerId ?? null)
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
  return { id: row.id, name: row.name, key: row.key, createdAt: row.created_at, lastUsedAt: row.last_used_at ?? undefined, ownerId: row.owner_id ?? undefined }
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

  async record(keyId: string, model: string, hour: string, requests: number, inputTokens: number, outputTokens: number, client?: string): Promise<void> {
    const c = client || ""
    this.db.query(
      `INSERT INTO usage (key_id, model, hour, client, requests, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_id, model, hour, client) DO UPDATE SET requests = requests + excluded.requests, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
    ).run(keyId, model, hour, c, requests, inputTokens, outputTokens)
  }

  async query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<UsageRecord[]> {
    let rows: any[]
    if (opts.keyIds && opts.keyIds.length > 0) {
      const placeholders = opts.keyIds.map(() => "?").join(",")
      rows = this.db.query(`SELECT key_id, model, hour, client, requests, input_tokens, output_tokens FROM usage WHERE key_id IN (${placeholders}) AND hour >= ? AND hour < ? ORDER BY hour`).all(...opts.keyIds, opts.start, opts.end)
    } else if (opts.keyId) {
      rows = this.db.query("SELECT key_id, model, hour, client, requests, input_tokens, output_tokens FROM usage WHERE key_id = ? AND hour >= ? AND hour < ? ORDER BY hour").all(opts.keyId, opts.start, opts.end)
    } else {
      rows = this.db.query("SELECT key_id, model, hour, client, requests, input_tokens, output_tokens FROM usage WHERE hour >= ? AND hour < ? ORDER BY hour").all(opts.start, opts.end)
    }
    return rows.map((r: any) => ({ keyId: r.key_id, model: r.model, hour: r.hour, client: r.client || "", requests: r.requests, inputTokens: r.input_tokens, outputTokens: r.output_tokens }))
  }

  async listAll(): Promise<UsageRecord[]> {
    return this.db.query<any, []>("SELECT key_id, model, hour, client, requests, input_tokens, output_tokens FROM usage ORDER BY hour").all()
      .map((r: any) => ({ keyId: r.key_id, model: r.model, hour: r.hour, client: r.client || "", requests: r.requests, inputTokens: r.input_tokens, outputTokens: r.output_tokens }))
  }

  async set(record: UsageRecord): Promise<void> {
    const c = record.client || ""
    this.db.query(
      `INSERT INTO usage (key_id, model, hour, client, requests, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_id, model, hour, client) DO UPDATE SET requests = excluded.requests, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens`,
    ).run(record.keyId, record.model, record.hour, c, record.requests, record.inputTokens, record.outputTokens)
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
    this.db.query("INSERT INTO users (id, name, created_at, disabled, last_login_at, user_key) VALUES (?, ?, ?, ?, ?, ?)").run(user.id, user.name, user.createdAt, user.disabled ? 1 : 0, user.lastLoginAt ?? null, user.userKey ?? null)
  }

  async getById(id: string): Promise<User | null> {
    const row = this.db.query<any, [string]>("SELECT id, name, created_at, disabled, last_login_at, user_key FROM users WHERE id = ?").get(id)
    return row ? { id: row.id, name: row.name, createdAt: row.created_at, disabled: row.disabled === 1, lastLoginAt: row.last_login_at ?? undefined, userKey: row.user_key ?? undefined } : null
  }

  async findByKey(userKey: string): Promise<User | null> {
    const row = this.db.query<any, [string]>("SELECT id, name, created_at, disabled, last_login_at, user_key FROM users WHERE user_key = ?").get(userKey)
    return row ? { id: row.id, name: row.name, createdAt: row.created_at, disabled: row.disabled === 1, lastLoginAt: row.last_login_at ?? undefined, userKey: row.user_key ?? undefined } : null
  }

  async list(): Promise<User[]> {
    return this.db.query<any, []>("SELECT id, name, created_at, disabled, last_login_at, user_key FROM users ORDER BY created_at").all()
      .map((r: any) => ({ id: r.id, name: r.name, createdAt: r.created_at, disabled: r.disabled === 1, lastLoginAt: r.last_login_at ?? undefined, userKey: r.user_key ?? undefined }))
  }

  async update(id: string, fields: Partial<Pick<User, "name" | "disabled" | "lastLoginAt" | "userKey">>): Promise<void> {
    const sets: string[] = []
    const binds: any[] = []
    if (fields.name !== undefined) { sets.push("name = ?"); binds.push(fields.name) }
    if (fields.disabled !== undefined) { sets.push("disabled = ?"); binds.push(fields.disabled ? 1 : 0) }
    if (fields.lastLoginAt !== undefined) { sets.push("last_login_at = ?"); binds.push(fields.lastLoginAt) }
    if (fields.userKey !== undefined) { sets.push("user_key = ?"); binds.push(fields.userKey) }
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
    this.db.query("INSERT INTO invite_codes (id, code, name, created_at, used_at, used_by) VALUES (?, ?, ?, ?, ?, ?)").run(code.id, code.code, code.name, code.createdAt, code.usedAt ?? null, code.usedBy ?? null)
  }

  async findByCode(code: string): Promise<InviteCode | null> {
    const row = this.db.query<any, [string]>("SELECT id, code, name, created_at, used_at, used_by FROM invite_codes WHERE code = ?").get(code)
    return row ? { id: row.id, code: row.code, name: row.name, createdAt: row.created_at, usedAt: row.used_at ?? undefined, usedBy: row.used_by ?? undefined } : null
  }

  async list(): Promise<InviteCode[]> {
    return this.db.query<any, []>("SELECT id, code, name, created_at, used_at, used_by FROM invite_codes ORDER BY created_at DESC").all()
      .map((r: any) => ({ id: r.id, code: r.code, name: r.name, createdAt: r.created_at, usedAt: r.used_at ?? undefined, usedBy: r.used_by ?? undefined }))
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
  const rows = db.query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?) WHERE name = ?").all(table, column)
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
  }
}

export function createSqliteDb(path: string): Database {
  return new Database(path)
}
