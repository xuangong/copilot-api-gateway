-- Persistence for Responses-API output items the gateway mints on the
-- client's behalf (currently only `web_search_call`). Keyed by the
-- gateway-minted id; the public-facing `item_json` is what we sent on the
-- first turn, and `private_json` carries gateway-side state (search
-- results, queries) needed to reconstruct an equivalent tool exchange
-- when the client echoes the id back on a follow-up turn.
CREATE TABLE IF NOT EXISTS responses_items (
  id TEXT PRIMARY KEY,
  api_key_id TEXT,
  kind TEXT NOT NULL,
  item_json TEXT NOT NULL,
  private_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_responses_items_expires ON responses_items (expires_at);
