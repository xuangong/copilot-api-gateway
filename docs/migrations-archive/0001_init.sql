-- API Keys for authentication
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- GitHub accounts (multi-account support)
CREATE TABLE github_accounts (
  user_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'individual',
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT
);

-- Config store (active account, cache, etc.)
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Usage tracking per API key
CREATE TABLE usage (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  hour TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, model, hour)
);

CREATE INDEX idx_usage_hour ON usage (hour);
