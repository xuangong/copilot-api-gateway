-- Configuration change generation. Current snapshots are retained until replaced.
CREATE TABLE IF NOT EXISTS configuration_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
INSERT OR IGNORE INTO configuration_revision (id, revision) VALUES (1, 0);
CREATE TRIGGER IF NOT EXISTS configuration_api_keys_insert AFTER INSERT ON api_keys
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_api_keys_update AFTER UPDATE ON api_keys WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.key IS NOT NEW.key OR OLD.created_at IS NOT NEW.created_at OR OLD.owner_id IS NOT NEW.owner_id OR OLD.quota_requests_per_month IS NOT NEW.quota_requests_per_month OR OLD.quota_tokens_per_month IS NOT NEW.quota_tokens_per_month OR OLD.quota_cost_per_month IS NOT NEW.quota_cost_per_month OR OLD.web_search_enabled IS NOT NEW.web_search_enabled OR OLD.web_search_langsearch_key IS NOT NEW.web_search_langsearch_key OR OLD.web_search_tavily_key IS NOT NEW.web_search_tavily_key OR OLD.web_search_ms_grounding_key IS NOT NEW.web_search_ms_grounding_key OR OLD.web_search_priority IS NOT NEW.web_search_priority OR OLD.web_search_langsearch_ref IS NOT NEW.web_search_langsearch_ref OR OLD.web_search_tavily_ref IS NOT NEW.web_search_tavily_ref OR OLD.web_search_ms_grounding_ref IS NOT NEW.web_search_ms_grounding_ref OR OLD.web_search_jina_key IS NOT NEW.web_search_jina_key OR OLD.web_search_jina_ref IS NOT NEW.web_search_jina_ref OR OLD.web_search_passthrough_upstream IS NOT NEW.web_search_passthrough_upstream OR OLD.web_search_passthrough_model IS NOT NEW.web_search_passthrough_model OR OLD.dump_retention_seconds IS NOT NEW.dump_retention_seconds OR OLD.model_mappings_enabled IS NOT NEW.model_mappings_enabled OR OLD.model_mappings IS NOT NEW.model_mappings
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_api_keys_delete AFTER DELETE ON api_keys
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_users_insert AFTER INSERT ON users
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_users_update AFTER UPDATE ON users WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.email IS NOT NEW.email OR OLD.avatar_url IS NOT NEW.avatar_url OR OLD.created_at IS NOT NEW.created_at OR OLD.disabled IS NOT NEW.disabled OR OLD.user_key IS NOT NEW.user_key OR OLD.password_hash IS NOT NEW.password_hash
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_users_delete AFTER DELETE ON users
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_upstreams_insert AFTER INSERT ON upstreams
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
-- Single-account OAuth providers update quota on every response. Exclude only
-- this advisory field and updated_at; credentials and all other state still count.
CREATE TRIGGER IF NOT EXISTS configuration_upstreams_update AFTER UPDATE ON upstreams WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.provider IS NOT NEW.provider OR OLD.name IS NOT NEW.name OR OLD.enabled IS NOT NEW.enabled OR OLD.sort_order IS NOT NEW.sort_order OR OLD.config_json IS NOT NEW.config_json OR OLD.flag_overrides IS NOT NEW.flag_overrides OR OLD.disabled_public_model_ids IS NOT NEW.disabled_public_model_ids OR (CASE WHEN OLD.provider IN ('codex', 'claude-code') AND json_valid(OLD.state_json) THEN json_remove(OLD.state_json, '$.accounts[0].quotaSnapshot') ELSE OLD.state_json END) IS NOT (CASE WHEN NEW.provider IN ('codex', 'claude-code') AND json_valid(NEW.state_json) THEN json_remove(NEW.state_json, '$.accounts[0].quotaSnapshot') ELSE NEW.state_json END) OR OLD.proxy_fallback_list_json IS NOT NEW.proxy_fallback_list_json OR OLD.created_at IS NOT NEW.created_at
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_upstreams_delete AFTER DELETE ON upstreams
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_proxies_insert AFTER INSERT ON proxies
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_proxies_update AFTER UPDATE ON proxies WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.url IS NOT NEW.url OR OLD.dial_timeout_seconds IS NOT NEW.dial_timeout_seconds OR OLD.updated_at IS NOT NEW.updated_at
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_proxies_delete AFTER DELETE ON proxies
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_sessions_insert AFTER INSERT ON user_sessions
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_sessions_update AFTER UPDATE ON user_sessions
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS configuration_sessions_delete AFTER DELETE ON user_sessions
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
