-- migration 0027_rewrite_legacy_upstream_ids.sql
--
-- Rewrite legacy `upstream='copilot:<github_user_id>'` rows on usage,
-- performance_summary, and performance_latency_buckets to the new
-- `up_copilot_<owner>_<github_user_id>` form introduced in 0026.
--
-- Without this the dashboard's groupby-upstream charts show two arbitrary
-- series for the same source (the old copilot:N id vs the new up_… id)
-- after the binding-based router started writing rows with the new id.
--
-- Strategy: for each legacy row whose `copilot:N` maps to an existing
-- upstream record, INSERT…ON CONFLICT DO UPDATE on the new id to merge
-- counters, then DELETE the legacy row in the same transaction. Rows
-- whose mapping doesn't exist (account was deleted) are left untouched —
-- they remain attributable to the GitHub user id even after the
-- registry entry is gone.

-- ── usage ────────────────────────────────────────────────────────────
INSERT INTO usage (
  key_id, model, upstream, hour, client,
  requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_json
)
SELECT
  u.key_id, u.model,
  (SELECT up.id FROM upstreams up
    WHERE up.provider = 'copilot'
      AND json_extract(up.config_json, '$.user.id') = CAST(substr(u.upstream, 9) AS INTEGER)
    LIMIT 1) AS new_upstream,
  u.hour, u.client,
  u.requests, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens, u.cost_json
FROM usage u
WHERE u.upstream LIKE 'copilot:%'
  AND EXISTS (SELECT 1 FROM upstreams up
                WHERE up.provider='copilot'
                  AND json_extract(up.config_json, '$.user.id') = CAST(substr(u.upstream, 9) AS INTEGER))
ON CONFLICT (key_id, model, COALESCE(upstream, ''), hour, client) DO UPDATE SET
  requests = usage.requests + excluded.requests,
  input_tokens = usage.input_tokens + excluded.input_tokens,
  output_tokens = usage.output_tokens + excluded.output_tokens,
  cache_read_tokens = usage.cache_read_tokens + excluded.cache_read_tokens,
  cache_creation_tokens = usage.cache_creation_tokens + excluded.cache_creation_tokens;

DELETE FROM usage
WHERE upstream LIKE 'copilot:%'
  AND EXISTS (SELECT 1 FROM upstreams up
                WHERE up.provider='copilot'
                  AND json_extract(up.config_json, '$.user.id') = CAST(substr(usage.upstream, 9) AS INTEGER));

-- ── performance_summary ─────────────────────────────────────────────
INSERT INTO performance_summary (
  hour, metric_scope, key_id, model, upstream, source_api, target_api,
  stream, runtime_location, requests, errors, total_ms_sum
)
SELECT
  p.hour, p.metric_scope, p.key_id, p.model,
  (SELECT up.id FROM upstreams up
    WHERE up.provider = 'copilot'
      AND json_extract(up.config_json, '$.user.id') = CAST(substr(p.upstream, 9) AS INTEGER)
    LIMIT 1) AS new_upstream,
  p.source_api, p.target_api, p.stream, p.runtime_location,
  p.requests, p.errors, p.total_ms_sum
FROM performance_summary p
WHERE p.upstream LIKE 'copilot:%'
  AND EXISTS (SELECT 1 FROM upstreams up
                WHERE up.provider='copilot'
                  AND json_extract(up.config_json, '$.user.id') = CAST(substr(p.upstream, 9) AS INTEGER))
ON CONFLICT (hour, metric_scope, key_id, model, COALESCE(upstream, ''), source_api, target_api, stream, runtime_location) DO UPDATE SET
  requests = performance_summary.requests + excluded.requests,
  errors = performance_summary.errors + excluded.errors,
  total_ms_sum = performance_summary.total_ms_sum + excluded.total_ms_sum;

DELETE FROM performance_summary
WHERE upstream LIKE 'copilot:%'
  AND EXISTS (SELECT 1 FROM upstreams up
                WHERE up.provider='copilot'
                  AND json_extract(up.config_json, '$.user.id') = CAST(substr(performance_summary.upstream, 9) AS INTEGER));

-- ── performance_latency_buckets ─────────────────────────────────────
INSERT INTO performance_latency_buckets (
  hour, metric_scope, key_id, model, upstream, source_api, target_api,
  stream, runtime_location, lower_ms, upper_ms, count
)
SELECT
  b.hour, b.metric_scope, b.key_id, b.model,
  (SELECT up.id FROM upstreams up
    WHERE up.provider = 'copilot'
      AND json_extract(up.config_json, '$.user.id') = CAST(substr(b.upstream, 9) AS INTEGER)
    LIMIT 1) AS new_upstream,
  b.source_api, b.target_api, b.stream, b.runtime_location,
  b.lower_ms, b.upper_ms, b.count
FROM performance_latency_buckets b
WHERE b.upstream LIKE 'copilot:%'
  AND EXISTS (SELECT 1 FROM upstreams up
                WHERE up.provider='copilot'
                  AND json_extract(up.config_json, '$.user.id') = CAST(substr(b.upstream, 9) AS INTEGER))
ON CONFLICT (hour, metric_scope, key_id, model, COALESCE(upstream, ''), source_api, target_api, stream, runtime_location, lower_ms, upper_ms) DO UPDATE SET
  count = performance_latency_buckets.count + excluded.count;

DELETE FROM performance_latency_buckets
WHERE upstream LIKE 'copilot:%'
  AND EXISTS (SELECT 1 FROM upstreams up
                WHERE up.provider='copilot'
                  AND json_extract(up.config_json, '$.user.id') = CAST(substr(performance_latency_buckets.upstream, 9) AS INTEGER));
