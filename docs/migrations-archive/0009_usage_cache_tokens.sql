-- Add cache token tracking columns to usage table
ALTER TABLE usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
