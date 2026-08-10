-- Per-turn snapshot of /v1/responses input+output items, keyed by the
-- response.id we returned. The next turn — when the client sends
-- previous_response_id — the gateway loads this row, prepends `items_json`
-- to the new request's input, and strips previous_response_id before
-- forwarding upstream. Owner isolation is enforced via api_key_id (nullable
-- for anonymous keys; null only matches null at read time).
CREATE TABLE IF NOT EXISTS responses_snapshots (
  response_id TEXT PRIMARY KEY,
  api_key_id  TEXT,
  model       TEXT NOT NULL,
  items_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_responses_snapshots_expires
  ON responses_snapshots (expires_at);

CREATE INDEX IF NOT EXISTS idx_responses_snapshots_owner
  ON responses_snapshots (api_key_id, response_id);
