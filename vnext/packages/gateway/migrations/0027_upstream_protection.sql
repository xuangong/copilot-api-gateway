-- packages/gateway/migrations/0027_upstream_protection.sql
-- Upstream error protection: per-minute response counts by class, the latest error samples,
-- protection pauses/warnings and per-upstream protection settings.

-- `minute` is unix seconds at the start of the minute. One row per (upstream, minute, key, model);
-- `requests` counts every recorded response, the class columns count the non-2xx classes. 2xx is requests minus the classes.
CREATE TABLE upstream_request_minutes (
  minute INTEGER NOT NULL,
  upstream_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  rate_limited INTEGER NOT NULL DEFAULT 0 CHECK (rate_limited >= 0),
  rejected INTEGER NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  auth INTEGER NOT NULL DEFAULT 0 CHECK (auth >= 0),
  upstream INTEGER NOT NULL DEFAULT 0 CHECK (upstream >= 0),
  network INTEGER NOT NULL DEFAULT 0 CHECK (network >= 0),
  other INTEGER NOT NULL DEFAULT 0 CHECK (other >= 0),
  PRIMARY KEY (upstream_id, minute, key_id, model)
);
CREATE INDEX idx_upstream_request_minutes_minute ON upstream_request_minutes (minute);
CREATE INDEX idx_upstream_request_minutes_key ON upstream_request_minutes (key_id, minute);

-- The latest 20 per (upstream, status); `status` 0 is a network failure, `at` is unix ms.
-- Only the upstream's own error description is stored, never request or response content.
CREATE TABLE upstream_error_samples (
  upstream_id TEXT NOT NULL,
  status INTEGER NOT NULL,
  at INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_upstream_error_samples_latest ON upstream_error_samples (upstream_id, status, at);

-- Times are unix ms. A `notify` row records a warning, not a block. Active = resolved_at IS NULL AND ends_at > now.
CREATE TABLE protection_pauses (
  id TEXT PRIMARY KEY CHECK (length(id) = 35 AND id GLOB 'pp_*'),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('upstream', 'key')),
  target_id TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('pause', 'notify')),
  reason_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT CHECK (resolved_by IS NULL OR resolved_by IN ('auto', 'owner'))
);
CREATE INDEX idx_protection_pauses_active ON protection_pauses (ends_at) WHERE resolved_at IS NULL;
CREATE INDEX idx_protection_pauses_upstream ON protection_pauses (upstream_id, started_at);
CREATE INDEX idx_protection_pauses_target ON protection_pauses (target_kind, target_id, started_at);
CREATE INDEX idx_protection_pauses_started ON protection_pauses (started_at);

-- Protection settings per upstream (JSON validated by the control plane); a missing row means all defaults.
CREATE TABLE upstream_protection_settings (
  upstream_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
