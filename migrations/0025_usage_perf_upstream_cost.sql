-- Add upstream identity + per-row cost snapshot to usage and the two
-- performance tables. `upstream` is a stable provider-prefixed string:
--   "copilot:<user_id>"  for copilot rows (user_id is the github user)
--   "custom:<id>"        future custom OpenAI-compatible upstreams
--   "azure:<deployment>" future azure deployments
--   NULL                 historical rows that pre-date this migration
--
-- Composite identity for aggregation includes upstream so that two GitHub
-- accounts billing the same `model` for the same `key_id`/`hour` don't
-- collapse into one row.
--
-- cost_json is a frozen snapshot of pricing.ts at write time so the
-- aggregator can compute costs without re-resolving through the provider
-- registry forever (including for rows whose upstream has since been
-- deleted or whose pricing has since changed).

-- usage: rebuild table to include new identity column in the PK.
CREATE TABLE usage_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  hour TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_json TEXT
);

INSERT INTO usage_new (
  key_id, model, upstream, hour, client,
  requests, input_tokens, output_tokens,
  cache_read_tokens, cache_creation_tokens, cost_json
)
SELECT
  key_id, model, NULL, hour, client,
  requests, input_tokens, output_tokens,
  cache_read_tokens, cache_creation_tokens, NULL
FROM usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;

CREATE UNIQUE INDEX idx_usage_identity
  ON usage (key_id, model, COALESCE(upstream, ''), hour, client);
CREATE INDEX idx_usage_hour ON usage (hour);

-- performance_summary: same pattern.
CREATE TABLE performance_summary_new (
  hour TEXT NOT NULL,
  metric_scope TEXT NOT NULL,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  source_api TEXT NOT NULL,
  target_api TEXT NOT NULL,
  stream INTEGER NOT NULL,
  runtime_location TEXT NOT NULL DEFAULT 'unknown',
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  total_ms_sum INTEGER NOT NULL DEFAULT 0
);

INSERT INTO performance_summary_new (
  hour, metric_scope, key_id, model, upstream,
  source_api, target_api, stream, runtime_location,
  requests, errors, total_ms_sum
)
SELECT
  hour, metric_scope, key_id, model, NULL,
  source_api, target_api, stream, runtime_location,
  requests, errors, total_ms_sum
FROM performance_summary;

DROP TABLE performance_summary;
ALTER TABLE performance_summary_new RENAME TO performance_summary;

CREATE UNIQUE INDEX idx_performance_summary_identity
  ON performance_summary (
    hour, metric_scope, key_id, model, COALESCE(upstream, ''),
    source_api, target_api, stream, runtime_location
  );
CREATE INDEX idx_performance_summary_hour ON performance_summary (hour);

-- performance_latency_buckets: same pattern.
CREATE TABLE performance_latency_buckets_new (
  hour TEXT NOT NULL,
  metric_scope TEXT NOT NULL,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  source_api TEXT NOT NULL,
  target_api TEXT NOT NULL,
  stream INTEGER NOT NULL,
  runtime_location TEXT NOT NULL DEFAULT 'unknown',
  lower_ms INTEGER NOT NULL,
  upper_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

INSERT INTO performance_latency_buckets_new (
  hour, metric_scope, key_id, model, upstream,
  source_api, target_api, stream, runtime_location,
  lower_ms, upper_ms, count
)
SELECT
  hour, metric_scope, key_id, model, NULL,
  source_api, target_api, stream, runtime_location,
  lower_ms, upper_ms, count
FROM performance_latency_buckets;

DROP TABLE performance_latency_buckets;
ALTER TABLE performance_latency_buckets_new RENAME TO performance_latency_buckets;

CREATE UNIQUE INDEX idx_performance_latency_buckets_identity
  ON performance_latency_buckets (
    hour, metric_scope, key_id, model, COALESCE(upstream, ''),
    source_api, target_api, stream, runtime_location,
    lower_ms, upper_ms
  );
CREATE INDEX idx_performance_latency_buckets_hour
  ON performance_latency_buckets (hour);
