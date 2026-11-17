-- Telemetry: external systems push hourly metrics with a push-only key. `key_hash` is the SHA-256 hex of the `tlm_` key.
CREATE TABLE telemetry_sources (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id GLOB 'tls_*'),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  last_push_at TEXT
);
CREATE INDEX idx_telemetry_sources_owner ON telemetry_sources (owner_id, created_at);

-- `hour` is unix seconds at the top of an hour. `dims_key` is the canonical JSON of the sorted dims ('' when none).
-- The primary key prefix (source_id, metric, hour) serves per-metric range reads of the dimensioned rows.
CREATE TABLE telemetry_points (
  source_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  hour INTEGER NOT NULL,
  dims_key TEXT NOT NULL,
  dims_json TEXT NOT NULL,
  value REAL NOT NULL CHECK (value >= 0),
  unit TEXT NOT NULL CHECK (unit IN ('bytes', 'count', 'ms')),
  PRIMARY KEY (source_id, metric, hour, dims_key)
) WITHOUT ROWID;
-- Retention purges each class with its own predicate, so each uses its own partial index and never re-walks the other class.
CREATE INDEX idx_telemetry_points_hour_dims ON telemetry_points (hour) WHERE dims_key <> '';
CREATE INDEX idx_telemetry_points_hour_plain ON telemetry_points (hour) WHERE dims_key = '';

-- One row per (source, metric, hour): the sum over dims, rewritten by the same atomic batch that replaces the points.
-- Totals, first hours, the metric list, budget and surge baselines read this instead of scanning dimension rows.
CREATE TABLE telemetry_hourly (
  source_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  hour INTEGER NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('bytes', 'count', 'ms')),
  value REAL NOT NULL CHECK (value >= 0),
  PRIMARY KEY (source_id, metric, hour)
) WITHOUT ROWID;
CREATE INDEX idx_telemetry_hourly_hour ON telemetry_hourly (hour);
