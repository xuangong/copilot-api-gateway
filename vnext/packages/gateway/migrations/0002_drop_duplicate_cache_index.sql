-- Drop the duplicate cache_kv expiry index.
--
-- The Bun bootstrap named it idx_cache_kv_expires_at while the migration
-- corpus named it cache_kv_expires_at, so databases built by the former carry
-- both once the baseline lands. They index the same column; keeping both only
-- costs write amplification on a hot cache table.

DROP INDEX IF EXISTS idx_cache_kv_expires_at;
