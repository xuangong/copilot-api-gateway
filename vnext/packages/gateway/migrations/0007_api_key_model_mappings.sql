ALTER TABLE api_keys
  ADD COLUMN model_mappings_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE api_keys
  ADD COLUMN model_mappings TEXT NOT NULL DEFAULT
  '[{"source":"gpt-5.6-sol","destination":"gpt-5.6-sol-fast"}]';
