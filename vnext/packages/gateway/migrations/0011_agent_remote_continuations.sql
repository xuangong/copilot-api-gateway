-- Existing login tokens stay in user_sessions; Agents references a non-secret ID.
ALTER TABLE user_sessions ADD COLUMN agent_remote_id TEXT;
CREATE UNIQUE INDEX idx_user_sessions_agent_remote_id ON user_sessions(agent_remote_id);
CREATE TABLE agent_remote_continuations (
  handle_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES user_sessions(agent_remote_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  audience TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  authenticated_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_remote_continuations_user ON agent_remote_continuations(user_id);
CREATE INDEX idx_agent_remote_continuations_expiry ON agent_remote_continuations(expires_at);

-- D1 KV deletion cannot atomically consume a browser authentication challenge.
CREATE TABLE agent_remote_oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  return_path TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_remote_oauth_states_expiry ON agent_remote_oauth_states(expires_at);

CREATE INDEX idx_agent_remote_continuations_session ON agent_remote_continuations(session_id);
-- Embedded SQLite may disable foreign keys; revocation cleanup must still agree with D1.
CREATE TRIGGER agent_remote_session_delete AFTER DELETE ON user_sessions
BEGIN
  DELETE FROM agent_remote_continuations WHERE session_id = OLD.agent_remote_id;
END;
