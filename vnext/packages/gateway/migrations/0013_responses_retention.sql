ALTER TABLE api_keys ADD COLUMN responses_retention_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (responses_retention_seconds = 0 OR (responses_retention_seconds BETWEEN 86400 AND 315360000 AND responses_retention_seconds % 86400 = 0));
