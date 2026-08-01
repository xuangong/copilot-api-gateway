-- Spec 14: per-key request dump rolling retention window.
-- NULL (default) means dump capture is disabled for the key.
ALTER TABLE api_keys ADD COLUMN dump_retention_seconds INTEGER;
