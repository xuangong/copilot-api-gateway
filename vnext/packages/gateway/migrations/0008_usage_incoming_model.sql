ALTER TABLE usage
  ADD COLUMN incoming_model TEXT NOT NULL DEFAULT '';

ALTER TABLE usage_requests
  ADD COLUMN incoming_model TEXT NOT NULL DEFAULT '';

DROP INDEX idx_usage_identity;
DROP INDEX idx_usage_requests_identity;

CREATE UNIQUE INDEX idx_usage_identity
ON usage (
  key_id,
  incoming_model,
  model,
  COALESCE(upstream, ''),
  model_key,
  client,
  hour,
  dimension
);

CREATE UNIQUE INDEX idx_usage_requests_identity
ON usage_requests (
  key_id,
  incoming_model,
  model,
  COALESCE(upstream, ''),
  model_key,
  client,
  hour
);
