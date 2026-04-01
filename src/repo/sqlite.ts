import { Database } from "bun:sqlite"
import type {
  ApiKey,
  ApiKeyRepo,
  CacheRepo,
  GitHubAccount,
  GitHubRepo,
  LatencyRecord,
  LatencyRepo,
  Repo,
  UsageRecord,
  UsageRepo,
} from "./types"

const INIT_SQL = `
-- API Keys for authentication
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- GitHub accounts (multi-account support)
CREATE TABLE IF NOT EXISTS github_accounts (
  user_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'individual',
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT
);

-- Config store (active account, cache, etc.)
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Usage tracking per API key
CREATE TABLE IF NOT EXISTS usage (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  hour TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, model, hour)
);

CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage (hour);

-- Latency tracking per API key, model, hour, and colo
CREATE TABLE IF NOT EXISTS latency (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  hour TEXT NOT NULL,
  colo TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL DEFAULT 0,
  upstream_ms INTEGER NOT NULL DEFAULT 0,
  ttfb_ms INTEGER NOT NULL DEFAULT 0,
  token_miss INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, model, hour, colo)
);

CREATE INDEX IF NOT EXISTS idx_latency_hour ON latency (hour);
`

class SqliteApiKeyRepo implements ApiKeyRepo {
  constructor(private db: Database) {}

  async list(): Promise<ApiKey[]> {
    const rows = this.db
      .query<{ id: string; name: string; key: string; created_at: string; last_used_at: string | null }, []>(
        "SELECT id, name, key, created_at, last_used_at FROM api_keys ORDER BY created_at",
      )
      .all()
    return rows.map(toApiKey)
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const row = this.db
      .query<{ id: string; name: string; key: string; created_at: string; last_used_at: string | null }, [string]>(
        "SELECT id, name, key, created_at, last_used_at FROM api_keys WHERE key = ?",
      )
      .get(rawKey)
    return row ? toApiKey(row) : null
  }

  async getById(id: string): Promise<ApiKey | null> {
    const row = this.db
      .query<{ id: string; name: string; key: string; created_at: string; last_used_at: string | null }, [string]>(
        "SELECT id, name, key, created_at, last_used_at FROM api_keys WHERE id = ?",
      )
      .get(id)
    return row ? toApiKey(row) : null
  }

  async save(key: ApiKey): Promise<void> {
    this.db
      .query(
        `INSERT INTO api_keys (id, name, key, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, key = excluded.key, last_used_at = excluded.last_used_at`,
      )
      .run(key.id, key.name, key.key, key.createdAt, key.lastUsedAt ?? null)
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.query("DELETE FROM api_keys WHERE id = ?").run(id)
    return result.changes > 0
  }

  async deleteAll(): Promise<void> {
    this.db.query("DELETE FROM api_keys").run()
  }
}

function toApiKey(row: { id: string; name: string; key: string; created_at: string; last_used_at: string | null }): ApiKey {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
  }
}

class SqliteGitHubRepo implements GitHubRepo {
  constructor(private db: Database) {}

  async listAccounts(): Promise<GitHubAccount[]> {
    const rows = this.db
      .query<{ user_id: number; token: string; account_type: string; login: string; name: string | null; avatar_url: string }, []>(
        "SELECT user_id, token, account_type, login, name, avatar_url FROM github_accounts",
      )
      .all()
    return rows.map(toGitHubAccount)
  }

  async getAccount(userId: number): Promise<GitHubAccount | null> {
    const row = this.db
      .query<{ user_id: number; token: string; account_type: string; login: string; name: string | null; avatar_url: string }, [number]>(
        "SELECT user_id, token, account_type, login, name, avatar_url FROM github_accounts WHERE user_id = ?",
      )
      .get(userId)
    return row ? toGitHubAccount(row) : null
  }

  async saveAccount(userId: number, account: GitHubAccount): Promise<void> {
    this.db
      .query(
        `INSERT INTO github_accounts (user_id, token, account_type, login, name, avatar_url) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET token = excluded.token, account_type = excluded.account_type, login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url`,
      )
      .run(userId, account.token, account.accountType, account.user.login, account.user.name, account.user.avatar_url)
  }

  async deleteAccount(userId: number): Promise<void> {
    this.db.query("DELETE FROM github_accounts WHERE user_id = ?").run(userId)
  }

  async deleteAllAccounts(): Promise<void> {
    this.db.query("DELETE FROM github_accounts").run()
    await this.clearActiveId()
  }

  async getActiveId(): Promise<number | null> {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM config WHERE key = ?")
      .get("active_github_account")
    return row ? Number(row.value) : null
  }

  async setActiveId(userId: number): Promise<void> {
    this.db
      .query("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run("active_github_account", String(userId))
  }

  async clearActiveId(): Promise<void> {
    this.db.query("DELETE FROM config WHERE key = ?").run("active_github_account")
  }
}

function toGitHubAccount(row: { user_id: number; token: string; account_type: string; login: string; name: string | null; avatar_url: string }): GitHubAccount {
  return {
    token: row.token,
    accountType: row.account_type,
    user: {
      id: row.user_id,
      login: row.login,
      name: row.name,
      avatar_url: row.avatar_url,
    },
  }
}

class SqliteUsageRepo implements UsageRepo {
  constructor(private db: Database) {}

  async record(
    keyId: string,
    model: string,
    hour: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    this.db
      .query(
        `INSERT INTO usage (key_id, model, hour, requests, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (key_id, model, hour) DO UPDATE SET
           requests = requests + excluded.requests,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(keyId, model, hour, requests, inputTokens, outputTokens)
  }

  async query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]> {
    const rows = opts.keyId
      ? this.db
          .query<{ key_id: string; model: string; hour: string; requests: number; input_tokens: number; output_tokens: number }, [string, string, string]>(
            "SELECT key_id, model, hour, requests, input_tokens, output_tokens FROM usage WHERE key_id = ? AND hour >= ? AND hour < ? ORDER BY hour",
          )
          .all(opts.keyId, opts.start, opts.end)
      : this.db
          .query<{ key_id: string; model: string; hour: string; requests: number; input_tokens: number; output_tokens: number }, [string, string]>(
            "SELECT key_id, model, hour, requests, input_tokens, output_tokens FROM usage WHERE hour >= ? AND hour < ? ORDER BY hour",
          )
          .all(opts.start, opts.end)
    return rows.map((r) => ({
      keyId: r.key_id,
      model: r.model,
      hour: r.hour,
      requests: r.requests,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    }))
  }

  async listAll(): Promise<UsageRecord[]> {
    const rows = this.db
      .query<{ key_id: string; model: string; hour: string; requests: number; input_tokens: number; output_tokens: number }, []>(
        "SELECT key_id, model, hour, requests, input_tokens, output_tokens FROM usage ORDER BY hour",
      )
      .all()
    return rows.map((r) => ({
      keyId: r.key_id,
      model: r.model,
      hour: r.hour,
      requests: r.requests,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    }))
  }

  async set(record: UsageRecord): Promise<void> {
    this.db
      .query(
        `INSERT INTO usage (key_id, model, hour, requests, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (key_id, model, hour) DO UPDATE SET
           requests = excluded.requests,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens`,
      )
      .run(record.keyId, record.model, record.hour, record.requests, record.inputTokens, record.outputTokens)
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
    this.db
      .query("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value)
  }

  async delete(key: string): Promise<void> {
    this.db.query("DELETE FROM config WHERE key = ?").run(key)
  }
}

class SqliteLatencyRepo implements LatencyRepo {
  constructor(private db: Database) {}

  async record(entry: {
    keyId: string
    model: string
    hour: string
    colo: string
    totalMs: number
    upstreamMs: number
    ttfbMs: number
    tokenMiss: boolean
  }): Promise<void> {
    this.db
      .query(
        `INSERT INTO latency (key_id, model, hour, colo, requests, total_ms, upstream_ms, ttfb_ms, token_miss)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT (key_id, model, hour, colo) DO UPDATE SET
           requests = requests + 1,
           total_ms = total_ms + excluded.total_ms,
           upstream_ms = upstream_ms + excluded.upstream_ms,
           ttfb_ms = ttfb_ms + excluded.ttfb_ms,
           token_miss = token_miss + excluded.token_miss`,
      )
      .run(
        entry.keyId,
        entry.model,
        entry.hour,
        entry.colo,
        entry.totalMs,
        entry.upstreamMs,
        entry.ttfbMs,
        entry.tokenMiss ? 1 : 0,
      )
  }

  async query(opts: { keyId?: string; start: string; end: string }): Promise<LatencyRecord[]> {
    const rows = opts.keyId
      ? this.db
          .query<
            { key_id: string; model: string; hour: string; colo: string; requests: number; total_ms: number; upstream_ms: number; ttfb_ms: number; token_miss: number },
            [string, string, string]
          >(
            "SELECT key_id, model, hour, colo, requests, total_ms, upstream_ms, ttfb_ms, token_miss FROM latency WHERE key_id = ? AND hour >= ? AND hour < ? ORDER BY hour",
          )
          .all(opts.keyId, opts.start, opts.end)
      : this.db
          .query<
            { key_id: string; model: string; hour: string; colo: string; requests: number; total_ms: number; upstream_ms: number; ttfb_ms: number; token_miss: number },
            [string, string]
          >(
            "SELECT key_id, model, hour, colo, requests, total_ms, upstream_ms, ttfb_ms, token_miss FROM latency WHERE hour >= ? AND hour < ? ORDER BY hour",
          )
          .all(opts.start, opts.end)
    return rows.map((r) => ({
      keyId: r.key_id,
      model: r.model,
      hour: r.hour,
      colo: r.colo,
      requests: r.requests,
      totalMs: r.total_ms,
      upstreamMs: r.upstream_ms,
      ttfbMs: r.ttfb_ms,
      tokenMiss: r.token_miss,
    }))
  }

  async deleteAll(): Promise<void> {
    this.db.query("DELETE FROM latency").run()
  }
}

export class SqliteRepo implements Repo {
  apiKeys: ApiKeyRepo
  github: GitHubRepo
  usage: UsageRepo
  cache: CacheRepo
  latency: LatencyRepo

  constructor(db: Database) {
    // Initialize tables
    db.exec(INIT_SQL)

    this.apiKeys = new SqliteApiKeyRepo(db)
    this.github = new SqliteGitHubRepo(db)
    this.usage = new SqliteUsageRepo(db)
    this.cache = new SqliteCacheRepo(db)
    this.latency = new SqliteLatencyRepo(db)
  }
}

/**
 * Create a SQLite database instance
 * @param path - Path to SQLite file (use ":memory:" for in-memory)
 */
export function createSqliteDb(path: string): Database {
  return new Database(path)
}
