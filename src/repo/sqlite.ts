import { Database } from "bun:sqlite"

import type { Repo } from "./types"
import type { SqlExecutor } from "./shared/executor"
import { buildSharedRepo } from "./shared/repos"

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

CREATE TABLE IF NOT EXISTS web_search_engine_usage (
  key_id TEXT NOT NULL,
  engine_id TEXT NOT NULL,
  hour TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  empty_results INTEGER NOT NULL DEFAULT 0,
  total_results INTEGER NOT NULL DEFAULT 0,
  success_duration_ms INTEGER NOT NULL DEFAULT 0,
  failure_duration_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, engine_id, hour)
);
`

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query<{ name: string }, [string, string]>("SELECT name FROM pragma_table_info(?) WHERE name = ?").all(table, column)
  return rows.length > 0
}

function migrateSchema(db: Database): void {
  if (!hasColumn(db, "github_accounts", "owner_id")) {
    db.exec("ALTER TABLE github_accounts ADD COLUMN owner_id TEXT")
  }
  if (!hasColumn(db, "api_keys", "owner_id")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN owner_id TEXT")
  }
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
  if (!hasColumn(db, "users", "user_key")) {
    db.exec("ALTER TABLE users ADD COLUMN user_key TEXT")
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_key ON users(user_key)")
  }
  const pkInfo = db.query<{ name: string }, []>("PRAGMA table_info(github_accounts)").all()
  const ownerCol = pkInfo.find(c => c.name === "owner_id")
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
  if (!hasColumn(db, "usage", "cache_read_tokens")) {
    db.exec("ALTER TABLE usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0")
  }
  if (!hasColumn(db, "usage", "cache_creation_tokens")) {
    db.exec("ALTER TABLE usage ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0")
  }
  if (!hasColumn(db, "api_keys", "quota_requests_per_day")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN quota_requests_per_day INTEGER")
  }
  if (!hasColumn(db, "api_keys", "quota_tokens_per_day")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN quota_tokens_per_day INTEGER")
  }
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
  if (!hasColumn(db, "api_keys", "web_search_langsearch_ref")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_langsearch_ref TEXT")
  }
  if (!hasColumn(db, "api_keys", "web_search_tavily_ref")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_tavily_ref TEXT")
  }
  if (!hasColumn(db, "api_keys", "web_search_ms_grounding_ref")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_ms_grounding_ref TEXT")
  }
  if (!hasColumn(db, "api_keys", "web_search_ms_grounding_key")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_ms_grounding_key TEXT")
  }
  if (!hasColumn(db, "api_keys", "web_search_priority")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_priority TEXT")
  }
  if (!hasColumn(db, "users", "email")) {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT")
    db.exec("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)")
  }
  if (!hasColumn(db, "users", "avatar_url")) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT")
  }
  if (!hasColumn(db, "users", "password_hash")) {
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT")
  }
  if (!hasColumn(db, "invite_codes", "email")) {
    db.exec("ALTER TABLE invite_codes ADD COLUMN email TEXT")
  }
  db.exec(`CREATE TABLE IF NOT EXISTS key_assignments (
    key_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    assigned_by TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    PRIMARY KEY (key_id, user_id)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS observability_shares (
    owner_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, viewer_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_observability_shares_viewer ON observability_shares(viewer_id)`)
  db.exec(`CREATE TABLE IF NOT EXISTS device_codes (
    device_code TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    user_id TEXT,
    session_token TEXT,
    created_at TEXT NOT NULL
  )`)
  if (!hasColumn(db, "web_search_engine_usage", "success_duration_ms")) {
    db.exec("DROP TABLE IF EXISTS web_search_engine_usage")
    db.exec(`CREATE TABLE web_search_engine_usage (
      key_id TEXT NOT NULL,
      engine_id TEXT NOT NULL,
      hour TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      empty_results INTEGER NOT NULL DEFAULT 0,
      total_results INTEGER NOT NULL DEFAULT 0,
      success_duration_ms INTEGER NOT NULL DEFAULT 0,
      failure_duration_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_id, engine_id, hour)
    )`)
  }
}

class SqliteExecutor implements SqlExecutor {
  constructor(private db: Database) {}

  async all<T = any>(sql: string, binds: unknown[]): Promise<T[]> {
    return this.db.query(sql).all(...(binds as any[])) as T[]
  }

  async first<T = any>(sql: string, binds: unknown[]): Promise<T | null> {
    return (this.db.query(sql).get(...(binds as any[])) ?? null) as T | null
  }

  async run(sql: string, binds: unknown[]): Promise<{ changes: number }> {
    const r = this.db.query(sql).run(...(binds as any[]))
    return { changes: Number(r.changes) || 0 }
  }
}

export class SqliteRepo implements Repo {
  apiKeys: Repo["apiKeys"]
  github: Repo["github"]
  usage: Repo["usage"]
  cache: Repo["cache"]
  latency: Repo["latency"]
  users: Repo["users"]
  inviteCodes: Repo["inviteCodes"]
  sessions: Repo["sessions"]
  presence: Repo["presence"]
  webSearchUsage: Repo["webSearchUsage"]
  webSearchEngineUsage: Repo["webSearchEngineUsage"]
  keyAssignments: Repo["keyAssignments"]
  observabilityShares: Repo["observabilityShares"]
  deviceCodes: Repo["deviceCodes"]

  constructor(db: Database) {
    db.exec(INIT_SQL)
    migrateSchema(db)
    const shared = buildSharedRepo(new SqliteExecutor(db))
    this.apiKeys = shared.apiKeys
    this.github = shared.github
    this.usage = shared.usage
    this.cache = shared.cache
    this.latency = shared.latency
    this.users = shared.users
    this.inviteCodes = shared.inviteCodes
    this.sessions = shared.sessions
    this.presence = shared.presence
    this.webSearchUsage = shared.webSearchUsage
    this.webSearchEngineUsage = shared.webSearchEngineUsage
    this.keyAssignments = shared.keyAssignments
    this.observabilityShares = shared.observabilityShares
    this.deviceCodes = shared.deviceCodes
  }
}

export function createSqliteDb(path: string): Database {
  return new Database(path)
}
