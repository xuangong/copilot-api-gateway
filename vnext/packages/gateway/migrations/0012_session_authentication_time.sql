-- Token creation does not prove authentication: device authorization derives tokens.
-- Existing sessions have unknown provenance and must authenticate again for Agents.
ALTER TABLE user_sessions ADD COLUMN authenticated_at INTEGER;

-- Previous continuations inferred authentication time from token creation.
DELETE FROM agent_remote_continuations;
