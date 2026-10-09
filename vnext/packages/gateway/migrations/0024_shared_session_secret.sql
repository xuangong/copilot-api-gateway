ALTER TABLE api_keys ADD COLUMN shared_session_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN shared_session_secret TEXT;

CREATE TRIGGER configuration_api_keys_shared_session_update AFTER UPDATE OF shared_session_enabled, shared_session_secret ON api_keys
WHEN OLD.shared_session_enabled IS NOT NEW.shared_session_enabled OR OLD.shared_session_secret IS NOT NEW.shared_session_secret
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
