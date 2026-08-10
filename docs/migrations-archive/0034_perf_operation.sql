-- Spec 13-D-5-g (C1): add `operation` sub-call discriminator to the two
-- performance tables. NULL for the enclosing request row; set only when a
-- request internally dispatches profiled sub-calls (currently
-- 'image_generation' / 'image_edit' from the Responses image-generation
-- shim). Include COALESCE(operation,'') in the identity index so a single
-- (hour, key, model, upstream, …) can hold distinct rows per operation.

ALTER TABLE performance_summary ADD COLUMN operation TEXT;
DROP INDEX IF EXISTS idx_performance_summary_identity;
CREATE UNIQUE INDEX idx_performance_summary_identity
  ON performance_summary (
    hour, metric_scope, key_id, model, COALESCE(upstream, ''),
    source_api, target_api, stream, runtime_location,
    COALESCE(operation, '')
  );

ALTER TABLE performance_latency_buckets ADD COLUMN operation TEXT;
DROP INDEX IF EXISTS idx_performance_latency_buckets_identity;
CREATE UNIQUE INDEX idx_performance_latency_buckets_identity
  ON performance_latency_buckets (
    hour, metric_scope, key_id, model, COALESCE(upstream, ''),
    source_api, target_api, stream, runtime_location,
    COALESCE(operation, ''),
    lower_ms, upper_ms
  );
