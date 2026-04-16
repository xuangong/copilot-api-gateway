-- Client presence for LLM Relay (and similar) heartbeat tracking

CREATE TABLE IF NOT EXISTS client_presence (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  key_id TEXT,
  key_name TEXT,
  owner_id TEXT,
  gateway_url TEXT,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_client_presence_owner ON client_presence(owner_id);
CREATE INDEX IF NOT EXISTS idx_client_presence_key ON client_presence(key_id);
CREATE INDEX IF NOT EXISTS idx_client_presence_last_seen ON client_presence(last_seen_at);
