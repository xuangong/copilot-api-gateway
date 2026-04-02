-- Add stream column to latency table for separate streaming/sync tracking
-- D1 doesn't support ALTER TABLE to change PK, so we rebuild the table

ALTER TABLE latency RENAME TO latency_old;

CREATE TABLE latency (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  hour TEXT NOT NULL,
  colo TEXT NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL DEFAULT 0,
  upstream_ms INTEGER NOT NULL DEFAULT 0,
  ttfb_ms INTEGER NOT NULL DEFAULT 0,
  token_miss INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, model, hour, colo, stream)
);

INSERT INTO latency (key_id, model, hour, colo, stream, requests, total_ms, upstream_ms, ttfb_ms, token_miss)
  SELECT key_id, model, hour, colo, 0, requests, total_ms, upstream_ms, ttfb_ms, token_miss
  FROM latency_old;

DROP TABLE latency_old;

CREATE INDEX idx_latency_hour ON latency (hour);
