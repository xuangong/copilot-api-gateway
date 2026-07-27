-- Phase 13-C-1 (Spec 13): singleton search_config row for the web-search
-- reference stack (tavily / microsoft-grounding / jina) + Alpha passthrough.
-- Ported from reference migrations 0031/0043/0056 of copilot-gateway.
CREATE TABLE IF NOT EXISTS search_config (
  id                          INTEGER PRIMARY KEY,
  provider                    TEXT    NOT NULL DEFAULT 'disabled',
  tavily_api_key              TEXT    NOT NULL DEFAULT '',
  microsoft_grounding_api_key TEXT    NOT NULL DEFAULT '',
  jina_api_key                TEXT    NOT NULL DEFAULT '',
  passthrough_openai_search   INTEGER NOT NULL DEFAULT 0,
  alpha_search_upstream_id    TEXT    NOT NULL DEFAULT '',
  alpha_search_model          TEXT    NOT NULL DEFAULT '',
  updated_at                  TEXT    NOT NULL
);
