-- migrations/0031_cache_kv.sql
-- L2 cache shared between data-plane providers/registry and (future) other
-- modules. Values are stored as JSON text; `expires_at` is wall-clock ms so
-- D1Cache.get can filter past-TTL rows without scanning the body.

CREATE TABLE cache_kv (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX cache_kv_expires_at ON cache_kv(expires_at);
