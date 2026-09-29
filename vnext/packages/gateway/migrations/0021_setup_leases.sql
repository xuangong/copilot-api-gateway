CREATE TABLE setup_leases (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  id TEXT NOT NULL UNIQUE,
  minter_user_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_owner_id TEXT,
  client TEXT NOT NULL CHECK (client IN ('claude', 'codex')),
  platform TEXT NOT NULL CHECK (platform IN ('posix', 'windows')),
  settings_json TEXT NOT NULL CHECK (length(CAST(settings_json AS BLOB)) <= 8192),
  configuration_revision INTEGER NOT NULL,
  key_fingerprint TEXT NOT NULL CHECK (length(key_fingerprint) = 64),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT
);
CREATE INDEX setup_leases_expiry ON setup_leases (expires_at);
CREATE INDEX setup_leases_key ON setup_leases (key_id);
