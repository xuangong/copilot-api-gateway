-- NULL inherits visible upstreams; JSON arrays are ordered whitelists.
ALTER TABLE api_keys ADD COLUMN upstream_ids TEXT DEFAULT NULL;

-- This focused trigger supplements existing field-specific revision triggers.
CREATE TRIGGER configuration_api_key_upstreams_update
AFTER UPDATE OF upstream_ids ON api_keys
WHEN OLD.upstream_ids IS NOT NEW.upstream_ids
BEGIN
  UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1;
END;
