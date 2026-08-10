CREATE TABLE IF NOT EXISTS web_search_engine_usage (
  key_id TEXT NOT NULL,
  engine_id TEXT NOT NULL,
  hour TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  empty_results INTEGER NOT NULL DEFAULT 0,
  total_results INTEGER NOT NULL DEFAULT 0,
  success_duration_ms INTEGER NOT NULL DEFAULT 0,
  failure_duration_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, engine_id, hour)
);
