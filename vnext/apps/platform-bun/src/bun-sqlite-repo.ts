import { Database } from "bun:sqlite"

import type { Repo } from "@vnext/gateway/src/shared/repo/types.ts"
import type { SqlExecutor } from "@vnext/gateway/src/shared/repo/shared/executor.ts"
import { buildSharedRepo } from "@vnext/gateway/src/shared/repo/shared/repos.ts"

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
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  flag_overrides TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT,
  PRIMARY KEY (user_id, owner_id)
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS upstreams (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  flag_overrides TEXT NOT NULL DEFAULT '{}',
  disabled_public_model_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upstreams_owner_sort ON upstreams (owner_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_upstreams_provider_enabled_sort ON upstreams (provider, enabled, sort_order, created_at);

CREATE TABLE IF NOT EXISTS usage (
  key_id     TEXT NOT NULL,
  model      TEXT NOT NULL,
  upstream   TEXT,
  model_key  TEXT NOT NULL,
  client     TEXT NOT NULL DEFAULT '',
  hour       TEXT NOT NULL,
  dimension  TEXT NOT NULL,
  tokens     INTEGER NOT NULL,
  unit_price REAL
);
CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage (hour);

CREATE TABLE IF NOT EXISTS usage_requests (
  key_id    TEXT NOT NULL,
  model     TEXT NOT NULL,
  upstream  TEXT,
  model_key TEXT NOT NULL,
  client    TEXT NOT NULL DEFAULT '',
  hour      TEXT NOT NULL,
  requests  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_requests_hour ON usage_requests (hour);
-- Unique identity indexes for usage / usage_requests are created in
-- migrateSchema after the Plan 6 in-place migration runs, because
-- CREATE TABLE IF NOT EXISTS is a no-op against a pre-Plan-6 usage
-- table that lacks model_key / dimension columns.

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

CREATE TABLE IF NOT EXISTS performance_summary (
  hour TEXT NOT NULL,
  metric_scope TEXT NOT NULL,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  source_api TEXT NOT NULL,
  target_api TEXT NOT NULL,
  stream INTEGER NOT NULL,
  runtime_location TEXT NOT NULL DEFAULT 'unknown',
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  total_ms_sum INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_performance_summary_hour ON performance_summary (hour);

CREATE TABLE IF NOT EXISTS performance_latency_buckets (
  hour TEXT NOT NULL,
  metric_scope TEXT NOT NULL,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  source_api TEXT NOT NULL,
  target_api TEXT NOT NULL,
  stream INTEGER NOT NULL,
  runtime_location TEXT NOT NULL DEFAULT 'unknown',
  lower_ms INTEGER NOT NULL,
  upper_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_performance_latency_buckets_hour ON performance_latency_buckets (hour);

CREATE TABLE IF NOT EXISTS responses_items (
  id TEXT PRIMARY KEY,
  api_key_id TEXT,
  kind TEXT NOT NULL,
  item_json TEXT NOT NULL,
  private_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_responses_items_expires ON responses_items (expires_at);

CREATE TABLE IF NOT EXISTS cache_kv (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_kv_expires_at ON cache_kv (expires_at);
`

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query<{ name: string }, [string, string]>("SELECT name FROM pragma_table_info(?) WHERE name = ?").all(table, column)
  return rows.length > 0
}

function copilotUpstreamId(ownerId: string, userId: number): string {
  return `up_copilot_${ownerId || "global"}_${userId}`.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/**
 * Rewrite legacy `upstream='copilot:<github_user_id>'` rows on usage,
 * performance_summary, performance_latency_buckets to the new upstream
 * registry id. Idempotent: a second run finds no matching rows.
 *
 * Mirrors migrations/0027_rewrite_legacy_upstream_ids.sql. Lives here too so
 * boot-time SQLite (the bun-only docker / dev path) self-heals without a
 * separate migration runner.
 */
function rewriteLegacyUpstreamIds(db: Database): void {
  // Plan 6: `usage` split into (usage, usage_requests) with per-dimension rows
  // and a `model_key` identity column. Each table keeps its own copilot:%
  // rewrite logic; perf tables retain the original column shape.
  for (const table of ["usage", "usage_requests", "performance_summary", "performance_latency_buckets"]) {
    const hasRows = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table} WHERE upstream LIKE 'copilot:%'`).get()
    if (!hasRows || hasRows.n === 0) continue
    const cols = table === "usage"
      ? "key_id, model, upstream, model_key, client, hour, dimension, tokens, unit_price"
      : table === "usage_requests"
        ? "key_id, model, upstream, model_key, client, hour, requests"
        : table === "performance_summary"
          ? "hour, metric_scope, key_id, model, upstream, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum"
          : "hour, metric_scope, key_id, model, upstream, source_api, target_api, stream, runtime_location, lower_ms, upper_ms, count"
    const conflictKey = table === "usage"
      ? "(key_id, model, COALESCE(upstream, ''), model_key, client, hour, dimension)"
      : table === "usage_requests"
        ? "(key_id, model, COALESCE(upstream, ''), model_key, client, hour)"
        : table === "performance_summary"
          ? "(hour, metric_scope, key_id, model, COALESCE(upstream, ''), source_api, target_api, stream, runtime_location)"
          : "(hour, metric_scope, key_id, model, COALESCE(upstream, ''), source_api, target_api, stream, runtime_location, lower_ms, upper_ms)"
    const setClause = table === "usage"
      ? `tokens = ${table}.tokens + excluded.tokens`
      : table === "usage_requests"
        ? `requests = ${table}.requests + excluded.requests`
        : table === "performance_summary"
          ? `requests = ${table}.requests + excluded.requests,
             errors = ${table}.errors + excluded.errors,
             total_ms_sum = ${table}.total_ms_sum + excluded.total_ms_sum`
          : `count = ${table}.count + excluded.count`
    const selectExprs = table === "usage"
      ? "t.key_id, t.model, MAPPED, t.model_key, t.client, t.hour, t.dimension, t.tokens, t.unit_price"
      : table === "usage_requests"
        ? "t.key_id, t.model, MAPPED, t.model_key, t.client, t.hour, t.requests"
        : table === "performance_summary"
          ? "t.hour, t.metric_scope, t.key_id, t.model, MAPPED, t.source_api, t.target_api, t.stream, t.runtime_location, t.requests, t.errors, t.total_ms_sum"
          : "t.hour, t.metric_scope, t.key_id, t.model, MAPPED, t.source_api, t.target_api, t.stream, t.runtime_location, t.lower_ms, t.upper_ms, t.count"
    const mapped = `(SELECT up.id FROM upstreams up WHERE up.provider='copilot' AND json_extract(up.config_json, '$.user.id') = CAST(substr(t.upstream, 9) AS INTEGER) LIMIT 1)`
    db.exec(`
      INSERT INTO ${table} (${cols})
      SELECT ${selectExprs.replace("MAPPED", mapped)}
      FROM ${table} t
      WHERE t.upstream LIKE 'copilot:%'
        AND EXISTS (SELECT 1 FROM upstreams up WHERE up.provider='copilot' AND json_extract(up.config_json, '$.user.id') = CAST(substr(t.upstream, 9) AS INTEGER))
      ON CONFLICT ${conflictKey} DO UPDATE SET ${setClause};
      DELETE FROM ${table} WHERE upstream LIKE 'copilot:%'
        AND EXISTS (SELECT 1 FROM upstreams up WHERE up.provider='copilot' AND json_extract(up.config_json, '$.user.id') = CAST(substr(${table}.upstream, 9) AS INTEGER));
    `)
  }
}

function ensureUpstreams(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS upstreams (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      flag_overrides TEXT NOT NULL DEFAULT '{}',
      disabled_public_model_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_upstreams_owner_sort ON upstreams (owner_id, sort_order, created_at);
    CREATE INDEX IF NOT EXISTS idx_upstreams_provider_enabled_sort ON upstreams (provider, enabled, sort_order, created_at);
  `)

  const accounts = db.query<{
    user_id: number
    token: string
    account_type: string
    login: string
    name: string | null
    avatar_url: string | null
    owner_id: string | null
    enabled: number | null
    sort_order: number | null
    flag_overrides: string | null
    updated_at: string | null
  }, []>("SELECT user_id, token, account_type, login, name, avatar_url, owner_id, enabled, sort_order, flag_overrides, updated_at FROM github_accounts").all()
  const now = new Date().toISOString()
  const insert = db.query(`
    INSERT OR IGNORE INTO upstreams (id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, created_at, updated_at)
    VALUES (?, ?, 'copilot', ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const account of accounts) {
    const ownerId = account.owner_id ?? ""
    const id = copilotUpstreamId(ownerId, account.user_id)
    const config = JSON.stringify({
      githubToken: account.token,
      accountType: account.account_type,
      user: {
        id: account.user_id,
        login: account.login,
        name: account.name,
        avatar_url: account.avatar_url,
      },
    })
    insert.run(
      id,
      ownerId,
      account.login || `Copilot ${account.user_id}`,
      account.enabled === 0 ? 0 : 1,
      account.sort_order ?? 0,
      config,
      account.flag_overrides ?? "{}",
      account.updated_at ?? now,
      account.updated_at ?? now,
    )
  }
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
  // Plan 6: in-place upgrade legacy 4-column `usage` to per-dimension rows.
  // Detect legacy by presence of `input_tokens` (gone in new schema).
  if (hasColumn(db, "usage", "input_tokens")) {
    // Wrap the legacy → Plan 6 swap in a transaction so a crash mid-migration
    // can't leave the DB with `usage_dims_new` materialised but `usage` not yet
    // renamed (which would break startup on the next boot).
    db.exec(`
      BEGIN IMMEDIATE;
      -- Stage new tables under temp names so we can swap atomically.
      CREATE TABLE usage_dims_new (
        key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL,
        client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, dimension TEXT NOT NULL,
        tokens INTEGER NOT NULL, unit_price REAL
      );
      CREATE TABLE usage_reqs_new (
        key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL,
        client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, requests INTEGER NOT NULL
      );

      INSERT INTO usage_reqs_new (key_id, model, upstream, model_key, client, hour, requests)
        SELECT key_id, model, upstream, model AS model_key, client, hour, requests FROM usage;

      INSERT INTO usage_dims_new (key_id, model, upstream, model_key, client, hour, dimension, tokens, unit_price)
        SELECT key_id, model, upstream, model, client, hour, 'input', input_tokens, NULL FROM usage WHERE input_tokens > 0
        UNION ALL
        SELECT key_id, model, upstream, model, client, hour, 'output', output_tokens, NULL FROM usage WHERE output_tokens > 0
        UNION ALL
        SELECT key_id, model, upstream, model, client, hour, 'input_cache_read', cache_read_tokens, NULL FROM usage WHERE cache_read_tokens > 0
        UNION ALL
        SELECT key_id, model, upstream, model, client, hour, 'input_cache_write', cache_creation_tokens, NULL FROM usage WHERE cache_creation_tokens > 0;

      DROP TABLE usage;
      DROP TABLE IF EXISTS usage_requests;
      ALTER TABLE usage_dims_new RENAME TO usage;
      ALTER TABLE usage_reqs_new RENAME TO usage_requests;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_identity
        ON usage (key_id, model, COALESCE(upstream, ''), model_key, client, hour, dimension);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_requests_identity
        ON usage_requests (key_id, model, COALESCE(upstream, ''), model_key, client, hour);
      CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage (hour);
      CREATE INDEX IF NOT EXISTS idx_usage_requests_hour ON usage_requests (hour);
      COMMIT;
    `)
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
  // 0024: upstream fields on github_accounts
  if (!hasColumn(db, "github_accounts", "enabled")) {
    db.exec("ALTER TABLE github_accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1")
  }
  if (!hasColumn(db, "github_accounts", "sort_order")) {
    db.exec("ALTER TABLE github_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
  }
  if (!hasColumn(db, "github_accounts", "flag_overrides")) {
    db.exec("ALTER TABLE github_accounts ADD COLUMN flag_overrides TEXT NOT NULL DEFAULT '{}'")
  }
  if (!hasColumn(db, "github_accounts", "updated_at")) {
    db.exec("ALTER TABLE github_accounts ADD COLUMN updated_at TEXT")
  }
  // 0028: upstream disabled_public_model_ids
  if (!hasColumn(db, "upstreams", "disabled_public_model_ids")) {
    db.exec("ALTER TABLE upstreams ADD COLUMN disabled_public_model_ids TEXT NOT NULL DEFAULT '[]'")
  }
  // 0025: upstream identity + cost snapshot on usage/perf tables. Rebuild
  // each table when the column is missing so the unique index includes the
  // new identity dimension.
  if (!hasColumn(db, "usage", "upstream")) {
    db.exec(`
      CREATE TABLE usage_new (
        key_id TEXT NOT NULL,
        model TEXT NOT NULL,
        upstream TEXT,
        hour TEXT NOT NULL,
        client TEXT NOT NULL DEFAULT '',
        requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cost_json TEXT
      );
      INSERT INTO usage_new (key_id, model, upstream, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_json)
        SELECT key_id, model, NULL, hour, client, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, NULL FROM usage;
      DROP TABLE usage;
      ALTER TABLE usage_new RENAME TO usage;
      CREATE UNIQUE INDEX idx_usage_identity ON usage (key_id, model, COALESCE(upstream, ''), hour, client);
      CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage (hour);
    `)
  }
  if (!hasColumn(db, "performance_summary", "upstream")) {
    db.exec(`
      CREATE TABLE performance_summary_new (
        hour TEXT NOT NULL,
        metric_scope TEXT NOT NULL,
        key_id TEXT NOT NULL,
        model TEXT NOT NULL,
        upstream TEXT,
        source_api TEXT NOT NULL,
        target_api TEXT NOT NULL,
        stream INTEGER NOT NULL,
        runtime_location TEXT NOT NULL DEFAULT 'unknown',
        requests INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        total_ms_sum INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO performance_summary_new (hour, metric_scope, key_id, model, upstream, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum)
        SELECT hour, metric_scope, key_id, model, NULL, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum FROM performance_summary;
      DROP TABLE performance_summary;
      ALTER TABLE performance_summary_new RENAME TO performance_summary;
      CREATE UNIQUE INDEX idx_performance_summary_identity ON performance_summary (hour, metric_scope, key_id, model, COALESCE(upstream, ''), source_api, target_api, stream, runtime_location);
      CREATE INDEX IF NOT EXISTS idx_performance_summary_hour ON performance_summary (hour);
    `)
  }
  if (!hasColumn(db, "performance_latency_buckets", "upstream")) {
    db.exec(`
      CREATE TABLE performance_latency_buckets_new (
        hour TEXT NOT NULL,
        metric_scope TEXT NOT NULL,
        key_id TEXT NOT NULL,
        model TEXT NOT NULL,
        upstream TEXT,
        source_api TEXT NOT NULL,
        target_api TEXT NOT NULL,
        stream INTEGER NOT NULL,
        runtime_location TEXT NOT NULL DEFAULT 'unknown',
        lower_ms INTEGER NOT NULL,
        upper_ms INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO performance_latency_buckets_new (hour, metric_scope, key_id, model, upstream, source_api, target_api, stream, runtime_location, lower_ms, upper_ms, count)
        SELECT hour, metric_scope, key_id, model, NULL, source_api, target_api, stream, runtime_location, lower_ms, upper_ms, count FROM performance_latency_buckets;
      DROP TABLE performance_latency_buckets;
      ALTER TABLE performance_latency_buckets_new RENAME TO performance_latency_buckets;
      CREATE UNIQUE INDEX idx_performance_latency_buckets_identity ON performance_latency_buckets (hour, metric_scope, key_id, model, COALESCE(upstream, ''), source_api, target_api, stream, runtime_location, lower_ms, upper_ms);
      CREATE INDEX IF NOT EXISTS idx_performance_latency_buckets_hour ON performance_latency_buckets (hour);
    `)
  }
  // Fresh-DB safety net: INIT_SQL can't create these unique indexes because
  // pre-0025 schemas don't yet have the `upstream` column when CREATE TABLE
  // IF NOT EXISTS is a no-op against an older table. The migration branches
  // above handle old DBs; for new DBs we add the indexes here.
  // Plan 6: same reasoning applies to usage / usage_requests — the new
  // identity uses `model_key` + `dimension` which don't exist on legacy
  // tables, so the unique index must be created post-migration.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_identity
      ON usage (key_id, model, COALESCE(upstream, ''), model_key, client, hour, dimension);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_requests_identity
      ON usage_requests (key_id, model, COALESCE(upstream, ''), model_key, client, hour);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_performance_summary_identity
      ON performance_summary (hour, metric_scope, key_id, model, COALESCE(upstream, ''), source_api, target_api, stream, runtime_location);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_performance_latency_buckets_identity
      ON performance_latency_buckets (hour, metric_scope, key_id, model, COALESCE(upstream, ''), source_api, target_api, stream, runtime_location, lower_ms, upper_ms);
  `)
  ensureUpstreams(db)
  rewriteLegacyUpstreamIds(db)
}

export function initSqlite(db: Database): void {
  db.exec(INIT_SQL)
  migrateSchema(db)
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
  upstreams: Repo["upstreams"]
  usage: Repo["usage"]
  cache: Repo["cache"]
  latency: Repo["latency"]
  performance: Repo["performance"]
  users: Repo["users"]
  inviteCodes: Repo["inviteCodes"]
  sessions: Repo["sessions"]
  presence: Repo["presence"]
  webSearchUsage: Repo["webSearchUsage"]
  webSearchEngineUsage: Repo["webSearchEngineUsage"]
  keyAssignments: Repo["keyAssignments"]
  observabilityShares: Repo["observabilityShares"]
  deviceCodes: Repo["deviceCodes"]
  responsesItems: Repo["responsesItems"]

  constructor(db: Database) {
    initSqlite(db)
    const shared = buildSharedRepo(new SqliteExecutor(db))
    this.apiKeys = shared.apiKeys
    this.github = shared.github
    this.upstreams = shared.upstreams
    this.usage = shared.usage
    this.cache = shared.cache
    this.latency = shared.latency
    this.performance = shared.performance
    this.users = shared.users
    this.inviteCodes = shared.inviteCodes
    this.sessions = shared.sessions
    this.presence = shared.presence
    this.webSearchUsage = shared.webSearchUsage
    this.webSearchEngineUsage = shared.webSearchEngineUsage
    this.keyAssignments = shared.keyAssignments
    this.observabilityShares = shared.observabilityShares
    this.deviceCodes = shared.deviceCodes
    this.responsesItems = shared.responsesItems
  }
}

export function createSqliteDb(path: string): Database {
  return new Database(path)
}
