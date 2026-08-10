-- Convert the wide `usage` table into vNext's per-dimension shape and split
-- request counts into their own table.
--
-- Old shape kept one row per (key, model, upstream, hour, client) with a fixed
-- column per token kind. vNext stores one row per token *dimension* plus a
-- `unit_price` snapshot, so pricing changes never rewrite historical cost, and
-- new dimensions no longer require a schema change.
--
-- Token totals are preserved exactly: each non-zero column becomes one row, and
-- zero-valued columns are skipped (they carry no information and would only
-- bloat the unique index). `model_key` did not exist before, so it seeds from
-- `model` — matching how vNext derives it for providers without variants.
--
-- `cost_json` held per-request USD totals; vNext wants USD per million tokens,
-- hence the `/ tokens * 1e6` rescale. Rows without cost_json get NULL, which the
-- dashboard renders as an em dash.

CREATE TABLE usage_dims_new (
  key_id     TEXT NOT NULL,
  model      TEXT NOT NULL,
  upstream   TEXT,
  model_key  TEXT NOT NULL,
  client     TEXT NOT NULL DEFAULT '',
  hour       TEXT NOT NULL,
  dimension  TEXT NOT NULL,
  tokens     INTEGER NOT NULL,
  unit_price REAL
);

CREATE TABLE usage_reqs_new (
  key_id    TEXT NOT NULL,
  model     TEXT NOT NULL,
  upstream  TEXT,
  model_key TEXT NOT NULL,
  client    TEXT NOT NULL DEFAULT '',
  hour      TEXT NOT NULL,
  requests  INTEGER NOT NULL
);

INSERT INTO usage_reqs_new (key_id, model, upstream, model_key, client, hour, requests)
  SELECT key_id, model, upstream, model, client, hour, requests FROM usage;

INSERT INTO usage_dims_new (key_id, model, upstream, model_key, client, hour, dimension, tokens, unit_price)
  SELECT key_id, model, upstream, model, client, hour, 'input', input_tokens,
         json_extract(cost_json, '$.inputUSD') / input_tokens * 1e6
    FROM usage WHERE input_tokens > 0
  UNION ALL
  SELECT key_id, model, upstream, model, client, hour, 'output', output_tokens,
         json_extract(cost_json, '$.outputUSD') / output_tokens * 1e6
    FROM usage WHERE output_tokens > 0
  UNION ALL
  SELECT key_id, model, upstream, model, client, hour, 'input_cache_read', cache_read_tokens,
         json_extract(cost_json, '$.cacheReadUSD') / cache_read_tokens * 1e6
    FROM usage WHERE cache_read_tokens > 0
  UNION ALL
  SELECT key_id, model, upstream, model, client, hour, 'input_cache_write', cache_creation_tokens,
         json_extract(cost_json, '$.cacheWriteUSD') / cache_creation_tokens * 1e6
    FROM usage WHERE cache_creation_tokens > 0;

DROP TABLE usage;
ALTER TABLE usage_dims_new RENAME TO usage;
ALTER TABLE usage_reqs_new RENAME TO usage_requests;

CREATE UNIQUE INDEX idx_usage_identity
  ON usage (key_id, model, COALESCE(upstream, ''), model_key, client, hour, dimension);
CREATE INDEX idx_usage_hour ON usage (hour);
CREATE UNIQUE INDEX idx_usage_requests_identity
  ON usage_requests (key_id, model, COALESCE(upstream, ''), model_key, client, hour);
CREATE INDEX idx_usage_requests_hour ON usage_requests (hour);
