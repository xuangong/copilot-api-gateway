-- Move OpenAI-search passthrough onto the API key, and retire the global
-- search config it lived in.
--
-- `passthrough_openai_search` named one upstream and one model for the whole
-- gateway, then validated that pair against each caller's own visibility — the
-- reference project papered over the mismatch with an extra "outside this API
-- key scope" check. Upstreams are owner-scoped resources, so the pin belongs
-- on the key that will use it: different keys see different upstreams, and
-- only a specific (upstream, model) pair serves alpha_search at all.
--
-- `search_config` goes with it. Its engine half was replaced by the per-key
-- columns in 0005 and nothing reads the table any more. It never had a UI or
-- an API route in this codebase — the only way to populate it was editing the
-- database by hand — so there is no configuration here worth preserving.

ALTER TABLE api_keys ADD COLUMN web_search_passthrough_upstream TEXT;
ALTER TABLE api_keys ADD COLUMN web_search_passthrough_model TEXT;

DROP TABLE IF EXISTS search_config;
