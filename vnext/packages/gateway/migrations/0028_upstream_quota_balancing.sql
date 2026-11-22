-- 0028_upstream_quota_balancing.sql
-- Upstream groups with quota balancing: groups, membership, session assignments, quota reads, estimator state and gateway cost counters.

-- A group is one item in the routing order (sort_order shares the number space of its owner's upstreams). Settings JSON is validated by the control plane.
CREATE TABLE upstream_groups (
  id TEXT PRIMARY KEY CHECK (length(id) = 35 AND id GLOB 'ug_*'),
  owner_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_upstream_groups_owner ON upstream_groups (owner_id, sort_order, created_at);

-- Membership. Deliberately not part of the configuration-revision triggers: the data plane reads it through the group directory cache.
ALTER TABLE upstreams ADD COLUMN group_id TEXT;
CREATE INDEX idx_upstreams_group ON upstreams (group_id) WHERE group_id IS NOT NULL;

-- One row per (group, session). Times are unix ms. recent_cost_usd is the exponentially weighted (1 h) gateway spend as of recent_cost_at.
CREATE TABLE session_assignments (
  group_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  moved_at INTEGER NOT NULL,
  recent_cost_usd REAL NOT NULL DEFAULT 0,
  recent_cost_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, session_key)
);
CREATE INDEX idx_session_assignments_seen ON session_assignments (last_seen_at);
CREATE INDEX idx_session_assignments_upstream ON session_assignments (upstream_id);

-- Real (github) and calibrated (manual) quota reads. `at` is unix ms; share = used / entitlement of this read; cost_total_usd is the member's
-- cumulative gateway cost when the read was recorded (the difference of two reads is the cost of their interval).
CREATE TABLE quota_reads (
  upstream_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('github', 'manual')),
  used REAL NOT NULL,
  entitlement REAL NOT NULL,
  unlimited INTEGER NOT NULL DEFAULT 0,
  share REAL NOT NULL,
  cost_total_usd REAL NOT NULL,
  estimated_share_before REAL,
  error_points REAL,
  snapshot_key TEXT,
  unit_form TEXT,
  reset_at TEXT,
  PRIMARY KEY (upstream_id, at)
);
CREATE INDEX idx_quota_reads_at ON quota_reads (at);

-- Estimator, scheduling and cost counters of one group member. k is share per gateway USD, o is share per hour. last_calibration_at gives owner calibrations their own 10 minute floor; day_key / day_reads count the GitHub reads of one UTC day (not manual ones).
CREATE TABLE upstream_quota_state (
  upstream_id TEXT PRIMARY KEY,
  k REAL,
  k_prev REAL,
  k_samples INTEGER NOT NULL DEFAULT 0,
  o REAL NOT NULL DEFAULT 0,
  o_samples INTEGER NOT NULL DEFAULT 0,
  interval_hours REAL NOT NULL,
  learn_since INTEGER NOT NULL DEFAULT 0,
  last_read_at INTEGER,
  last_read_share REAL,
  last_read_unlimited INTEGER NOT NULL DEFAULT 0,
  last_read_source TEXT,
  last_attempt_at INTEGER,
  last_calibration_at INTEGER,
  day_key TEXT NOT NULL DEFAULT '',
  day_reads INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_read_at INTEGER NOT NULL,
  last_error_points REAL,
  entitlement REAL,
  entitlement_from REAL,
  entitlement_changed_at INTEGER,
  cost_total_usd REAL NOT NULL DEFAULT 0,
  cost_at_read_usd REAL NOT NULL DEFAULT 0,
  month_key TEXT NOT NULL DEFAULT '',
  month_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Gateway cost per member in 10-minute buckets (bucket = floor(unix ms / 600000)) for the recent burn rate.
CREATE TABLE upstream_cost_buckets (
  upstream_id TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (upstream_id, bucket)
);
CREATE INDEX idx_upstream_cost_buckets_bucket ON upstream_cost_buckets (bucket);
