-- Add per-key daily quota columns to api_keys
ALTER TABLE api_keys ADD COLUMN quota_requests_per_day INTEGER;
ALTER TABLE api_keys ADD COLUMN quota_tokens_per_day INTEGER;
