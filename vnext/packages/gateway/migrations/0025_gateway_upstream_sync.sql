-- Gateway upstream sync. A central gateway lists the devices allowed to pull a snapshot of selected upstreams;
-- a device gateway keeps at most one source to pull from and tags the rows it created.
CREATE TABLE sync_devices (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id GLOB 'sdv_*'),
  owner_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  upstream_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_sync_at TEXT
);
CREATE INDEX idx_sync_devices_owner ON sync_devices (owner_id, created_at);

-- `singleton` plus its UNIQUE constraint enforces "at most one row". `owner_id` is the user the synced upstreams belong to.
CREATE TABLE sync_sources (
  id TEXT PRIMARY KEY,
  singleton INTEGER NOT NULL DEFAULT 1 CHECK (singleton = 1) UNIQUE,
  owner_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  device_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  etag TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_error TEXT
);

-- Written only by INSERT (device apply) and never updated. It is deliberately not watched by
-- upstreams_catalog_generation or configuration_upstreams_update, so it cannot advance a generation.
ALTER TABLE upstreams ADD COLUMN sync_source_id TEXT;
CREATE INDEX idx_upstreams_sync_source ON upstreams (sync_source_id) WHERE sync_source_id IS NOT NULL;
