-- Stage D of vNext proxy fallback: per-upstream ordered proxy fallback list +
-- proxies catalog + per (proxy, upstream) exponential backoff bookkeeping.

ALTER TABLE upstreams ADD COLUMN proxy_fallback_list_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE proxies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  dial_timeout_seconds INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE proxy_upstream_backoffs (
  proxy_id TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  fail_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  last_error TEXT,
  last_error_at INTEGER,
  PRIMARY KEY (proxy_id, upstream_id)
);

CREATE INDEX idx_proxy_backoffs_upstream ON proxy_upstream_backoffs (upstream_id);
