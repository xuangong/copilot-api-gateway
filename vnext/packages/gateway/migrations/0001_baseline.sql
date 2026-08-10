-- Baseline schema.
--
-- Squashed from the 39 historical migrations, whose replay could no longer
-- reproduce the live schema: 0004's two owner_id ALTERs were commented out and
-- run by hand, and web_search_usage was never created by any migration at all.
-- Captured from the production D1 sqlite_master on 2026-08-10 so that a fresh
-- database and the live ones converge on the same object set.
--
-- Every statement is idempotent, so this file is a no-op against the two
-- existing databases beyond filling in objects they happen to lack. Existing
-- tables are left exactly as they are; CREATE TABLE IF NOT EXISTS does not
-- rewrite them, so historical column ordering differences persist and are
-- deliberately not reconciled.
--
-- The superseded migrations are kept for reference in docs/migrations-archive/.


-- ==================================================================
-- tables
-- ==================================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
, owner_id TEXT REFERENCES users(id), quota_requests_per_day INTEGER, quota_tokens_per_day INTEGER, web_search_enabled INTEGER DEFAULT 0, web_search_bing_enabled INTEGER DEFAULT 0, web_search_langsearch_key TEXT, web_search_tavily_key TEXT, web_search_copilot_enabled INTEGER DEFAULT 0, web_search_copilot_priority INTEGER DEFAULT 0, web_search_ms_grounding_key TEXT, web_search_priority TEXT, web_search_langsearch_ref TEXT, web_search_tavily_ref TEXT, web_search_ms_grounding_ref TEXT, dump_retention_seconds INTEGER);

CREATE TABLE IF NOT EXISTS cache_kv (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_codes (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  user_id TEXT,
  session_token TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dump_records (
  key_id TEXT NOT NULL,
  id TEXT NOT NULL,            
  created_at INTEGER NOT NULL, 
  upstream_id TEXT,
  meta_json TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  response_headers_json TEXT,
  request_body_descriptor TEXT,
  response_body_descriptor TEXT,
  PRIMARY KEY (key_id, id)
);

CREATE TABLE IF NOT EXISTS "github_accounts" (
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'individual',
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  owner_id TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, flag_overrides TEXT NOT NULL DEFAULT '{}', updated_at TEXT, github_host TEXT NOT NULL DEFAULT 'github.com', source TEXT,
  PRIMARY KEY (user_id, owner_id)
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES users(id)
, email TEXT);

CREATE TABLE IF NOT EXISTS key_assignments (key_id TEXT NOT NULL, user_id TEXT NOT NULL, assigned_by TEXT NOT NULL, assigned_at TEXT NOT NULL, PRIMARY KEY (key_id, user_id));

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

CREATE TABLE IF NOT EXISTS observability_shares (
  owner_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, viewer_id)
);

CREATE TABLE IF NOT EXISTS "performance_latency_buckets" (
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
, operation TEXT);

CREATE TABLE IF NOT EXISTS "performance_summary" (
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
, operation TEXT);

CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  dial_timeout_seconds INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_upstream_backoffs (
  proxy_id TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  fail_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  last_error TEXT,
  last_error_at INTEGER,
  PRIMARY KEY (proxy_id, upstream_id)
);

CREATE TABLE IF NOT EXISTS responses_items (
  id TEXT PRIMARY KEY,
  api_key_id TEXT,
  kind TEXT NOT NULL,
  item_json TEXT NOT NULL,
  private_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS responses_snapshots (
  response_id TEXT PRIMARY KEY,
  api_key_id  TEXT,
  model       TEXT NOT NULL,
  items_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS search_config (
  id                          INTEGER PRIMARY KEY,
  provider                    TEXT    NOT NULL DEFAULT 'disabled',
  tavily_api_key              TEXT    NOT NULL DEFAULT '',
  microsoft_grounding_api_key TEXT    NOT NULL DEFAULT '',
  jina_api_key                TEXT    NOT NULL DEFAULT '',
  passthrough_openai_search   INTEGER NOT NULL DEFAULT 0,
  alpha_search_upstream_id    TEXT    NOT NULL DEFAULT '',
  alpha_search_model          TEXT    NOT NULL DEFAULT '',
  updated_at                  TEXT    NOT NULL
, bing_api_key TEXT NOT NULL DEFAULT '', copilot_github_token TEXT NOT NULL DEFAULT '', langsearch_api_key TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS spilled_files (
  file_key TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'owned', 'retired')),
  collect_after INTEGER,
  claim_token TEXT,
  claimed_at INTEGER,
  CHECK (length(file_key) > 0),
  CHECK (length(owner_kind) > 0),
  CHECK (length(owner_key) > 0),
  CHECK ((state = 'owned') = (collect_after IS NULL)),
  CHECK ((claim_token IS NULL) = (claimed_at IS NULL)),
  CHECK (state != 'owned' OR claim_token IS NULL)
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, disabled_public_model_ids TEXT NOT NULL DEFAULT '[]', state_json TEXT, proxy_fallback_list_json TEXT NOT NULL DEFAULT '[]');

CREATE TABLE IF NOT EXISTS "usage" (
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

CREATE TABLE IF NOT EXISTS "usage_requests" (
  key_id    TEXT NOT NULL,
  model     TEXT NOT NULL,
  upstream  TEXT,
  model_key TEXT NOT NULL,
  client    TEXT NOT NULL DEFAULT '',
  hour      TEXT NOT NULL,
  requests  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT
, user_key TEXT, email TEXT, avatar_url TEXT, password_hash TEXT);

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

CREATE TABLE IF NOT EXISTS web_search_usage (key_id TEXT NOT NULL, hour TEXT NOT NULL, searches INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key_id, hour));


-- ==================================================================
-- indexs
-- ==================================================================

CREATE INDEX IF NOT EXISTS cache_kv_expires_at ON cache_kv(expires_at);

CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_id);

CREATE INDEX IF NOT EXISTS idx_client_presence_key ON client_presence(key_id);

CREATE INDEX IF NOT EXISTS idx_client_presence_last_seen ON client_presence(last_seen_at);

CREATE INDEX IF NOT EXISTS idx_client_presence_owner ON client_presence(owner_id);

CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code);

CREATE INDEX IF NOT EXISTS idx_dump_records_key_created ON dump_records(key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);

CREATE INDEX IF NOT EXISTS idx_latency_hour ON latency (hour);

CREATE INDEX IF NOT EXISTS idx_observability_shares_viewer ON observability_shares(viewer_id);

CREATE INDEX IF NOT EXISTS idx_performance_latency_buckets_hour
  ON performance_latency_buckets (hour);

CREATE UNIQUE INDEX IF NOT EXISTS idx_performance_latency_buckets_identity
  ON performance_latency_buckets (
    hour, metric_scope, key_id, model, COALESCE(upstream, ''),
    source_api, target_api, stream, runtime_location,
    COALESCE(operation, ''),
    lower_ms, upper_ms
  );

CREATE INDEX IF NOT EXISTS idx_performance_summary_hour ON performance_summary (hour);

CREATE UNIQUE INDEX IF NOT EXISTS idx_performance_summary_identity
  ON performance_summary (
    hour, metric_scope, key_id, model, COALESCE(upstream, ''),
    source_api, target_api, stream, runtime_location,
    COALESCE(operation, '')
  );

CREATE INDEX IF NOT EXISTS idx_proxy_backoffs_upstream ON proxy_upstream_backoffs (upstream_id);

CREATE INDEX IF NOT EXISTS idx_responses_items_expires ON responses_items (expires_at);

CREATE INDEX IF NOT EXISTS idx_responses_snapshots_expires
  ON responses_snapshots (expires_at);

CREATE INDEX IF NOT EXISTS idx_responses_snapshots_owner
  ON responses_snapshots (api_key_id, response_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_spilled_files_collectible
  ON spilled_files (collect_after, file_key)
  WHERE state != 'owned';

CREATE UNIQUE INDEX IF NOT EXISTS idx_spilled_files_owned_owner
  ON spilled_files (owner_kind, owner_key)
  WHERE state = 'owned';

CREATE INDEX IF NOT EXISTS idx_upstreams_owner_sort
  ON upstreams (owner_id, sort_order, created_at);

CREATE INDEX IF NOT EXISTS idx_upstreams_provider_enabled_sort
  ON upstreams (provider, enabled, sort_order, created_at);

CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage (hour);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_identity
  ON usage (key_id, model, COALESCE(upstream, ''), model_key, client, hour, dimension);

CREATE INDEX IF NOT EXISTS idx_usage_requests_hour ON usage_requests (hour);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_requests_identity
  ON usage_requests (key_id, model, COALESCE(upstream, ''), model_key, client, hour);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_key ON users(user_key);


-- ==================================================================
-- triggers
-- ==================================================================

CREATE TRIGGER IF NOT EXISTS dump_records_adopt_request_insert
AFTER INSERT ON dump_records
WHEN NEW.request_body_descriptor IS NOT NULL
BEGIN
  UPDATE spilled_files
  SET state = 'owned', collect_after = NULL
  WHERE file_key = json_extract(NEW.request_body_descriptor, '$.key')
    AND owner_kind = 'dump-request'
    AND owner_key = json_array(NEW.key_id, NEW.id)
    AND state = 'staged'
    AND claim_token IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS dump_records_adopt_response_insert
AFTER INSERT ON dump_records
WHEN NEW.response_body_descriptor IS NOT NULL
BEGIN
  UPDATE spilled_files
  SET state = 'owned', collect_after = NULL
  WHERE file_key = json_extract(NEW.response_body_descriptor, '$.key')
    AND owner_kind = 'dump-response'
    AND owner_key = json_array(NEW.key_id, NEW.id)
    AND state = 'staged'
    AND claim_token IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS dump_records_retire_request_delete
AFTER DELETE ON dump_records
WHEN OLD.request_body_descriptor IS NOT NULL
BEGIN
  UPDATE spilled_files
  SET state = 'retired', collect_after = 0
  WHERE file_key = json_extract(OLD.request_body_descriptor, '$.key')
    AND state = 'owned';
END;

CREATE TRIGGER IF NOT EXISTS dump_records_retire_response_delete
AFTER DELETE ON dump_records
WHEN OLD.response_body_descriptor IS NOT NULL
BEGIN
  UPDATE spilled_files
  SET state = 'retired', collect_after = 0
  WHERE file_key = json_extract(OLD.response_body_descriptor, '$.key')
    AND state = 'owned';
END;
