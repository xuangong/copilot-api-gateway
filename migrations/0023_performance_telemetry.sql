-- Backend-aggregated performance telemetry (per hour, per scope).
--
-- `performance_summary` stores requests, errors, and totalMs sum per slot
-- so /api/performance can compute averages, success rate and traffic
-- distribution without scanning raw events.
--
-- `performance_latency_buckets` stores per-slot histogram counts so the
-- same query can return percentile estimates (p50/p95/p99) from the
-- geometric √2 buckets defined in src/lib/performance-histogram.ts.
--
-- Schema mirrors copilot-gateway's 0006_performance_telemetry.sql so
-- the dashboard aggregator port stays straightforward.

CREATE TABLE performance_summary (
  hour TEXT NOT NULL,
  metric_scope TEXT NOT NULL CHECK (metric_scope IN ('request_total', 'upstream_success')),
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  source_api TEXT NOT NULL CHECK (source_api IN ('messages', 'responses', 'chat-completions', 'gemini', 'embeddings')),
  target_api TEXT NOT NULL CHECK (target_api IN ('messages', 'responses', 'chat-completions', 'embeddings')),
  stream INTEGER NOT NULL CHECK (stream IN (0, 1)),
  runtime_location TEXT NOT NULL DEFAULT 'unknown',
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  total_ms_sum INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, metric_scope, key_id, model, source_api, target_api, stream, runtime_location)
);

CREATE INDEX idx_performance_summary_hour ON performance_summary (hour);

CREATE TABLE performance_latency_buckets (
  hour TEXT NOT NULL,
  metric_scope TEXT NOT NULL CHECK (metric_scope IN ('request_total', 'upstream_success')),
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  source_api TEXT NOT NULL CHECK (source_api IN ('messages', 'responses', 'chat-completions', 'gemini', 'embeddings')),
  target_api TEXT NOT NULL CHECK (target_api IN ('messages', 'responses', 'chat-completions', 'embeddings')),
  stream INTEGER NOT NULL CHECK (stream IN (0, 1)),
  runtime_location TEXT NOT NULL DEFAULT 'unknown',
  lower_ms INTEGER NOT NULL,
  upper_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, metric_scope, key_id, model, source_api, target_api, stream, runtime_location, lower_ms, upper_ms)
);

CREATE INDEX idx_performance_latency_buckets_hour ON performance_latency_buckets (hour);
