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
);

CREATE INDEX IF NOT EXISTS idx_upstreams_owner_sort
  ON upstreams (owner_id, sort_order, created_at);

CREATE INDEX IF NOT EXISTS idx_upstreams_provider_enabled_sort
  ON upstreams (provider, enabled, sort_order, created_at);

INSERT OR IGNORE INTO upstreams (
  id,
  owner_id,
  provider,
  name,
  enabled,
  sort_order,
  config_json,
  flag_overrides,
  created_at,
  updated_at
)
SELECT
  'up_copilot_' || replace(replace(COALESCE(owner_id, ''), ':', '_'), '/', '_') || '_' || user_id,
  COALESCE(owner_id, ''),
  'copilot',
  login,
  COALESCE(enabled, 1),
  COALESCE(sort_order, 0),
  json_object(
    'githubToken', token,
    'accountType', account_type,
    'user', json_object(
      'id', user_id,
      'login', login,
      'name', name,
      'avatar_url', avatar_url
    )
  ),
  COALESCE(flag_overrides, '{}'),
  COALESCE(updated_at, datetime('now')),
  COALESCE(updated_at, datetime('now'))
FROM github_accounts;
