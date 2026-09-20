ALTER TABLE api_keys ADD COLUMN agent_remote_relay TEXT;
ALTER TABLE api_keys ADD COLUMN agent_remote_host_id TEXT;
CREATE UNIQUE INDEX api_keys_agent_remote_host ON api_keys(owner_id, agent_remote_relay, agent_remote_host_id)
  WHERE agent_remote_relay IS NOT NULL AND agent_remote_host_id IS NOT NULL;

-- Keep a tombstone after dashboard deletion, including deletion of all keys.
CREATE TABLE agent_remote_host_key_revocations (
  owner_id TEXT NOT NULL,
  relay TEXT NOT NULL,
  host_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  key_id TEXT,
  PRIMARY KEY (owner_id, relay, host_id)
);
CREATE TRIGGER agent_remote_host_key_deleted AFTER DELETE ON api_keys
WHEN OLD.agent_remote_relay IS NOT NULL AND OLD.agent_remote_host_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO agent_remote_host_key_revocations(owner_id, relay, host_id, revoked_at)
  VALUES (OLD.owner_id, OLD.agent_remote_relay, OLD.agent_remote_host_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE agent_remote_host_key_revocations SET key_id = OLD.id
    WHERE owner_id = OLD.owner_id AND relay = OLD.agent_remote_relay AND host_id = OLD.agent_remote_host_id;
END;
-- Inserting a tombstone and removing its key form one atomic statement on D1
-- and SQLite, including revocation before a delayed issuance request arrives.
CREATE TRIGGER agent_remote_host_key_revoked AFTER INSERT ON agent_remote_host_key_revocations
BEGIN
  DELETE FROM api_keys WHERE owner_id = NEW.owner_id AND agent_remote_relay = NEW.relay AND agent_remote_host_id = NEW.host_id;
END;
CREATE TRIGGER agent_remote_host_key_binding_immutable BEFORE UPDATE ON api_keys
WHEN OLD.agent_remote_relay IS NOT NULL AND
  (NEW.owner_id IS NOT OLD.owner_id OR NEW.agent_remote_relay IS NOT OLD.agent_remote_relay OR NEW.agent_remote_host_id IS NOT OLD.agent_remote_host_id)
BEGIN
  SELECT RAISE(ABORT, 'Agent Host key ownership is immutable');
END;

CREATE INDEX agent_remote_host_revoked_key_id ON agent_remote_host_key_revocations(key_id) WHERE key_id IS NOT NULL;
-- A dashboard update that read a key before revocation must not upsert it back.
CREATE TRIGGER agent_remote_host_key_no_resurrection BEFORE INSERT ON api_keys
WHEN EXISTS (SELECT 1 FROM agent_remote_host_key_revocations WHERE key_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'Agent Host key was revoked');
END;
