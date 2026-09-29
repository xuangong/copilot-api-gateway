-- Private, lazily initialized key material. Existing keys retain their values.
ALTER TABLE api_keys ADD COLUMN affinity_secret TEXT;
ALTER TABLE api_keys ADD COLUMN affinity_key_id TEXT;
ALTER TABLE api_keys ADD COLUMN affinity_version INTEGER;
