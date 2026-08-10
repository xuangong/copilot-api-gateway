-- Per-upstream mutable state, separate from `config`. Rotation on this column
-- (codex OAuth refresh_token, terminal states) goes through UpstreamRepo.saveState's
-- atomic read-modify-write. Nullable — providers without mutable credential
-- state (copilot/openai-compat/gemini/…) leave this NULL.
ALTER TABLE upstreams ADD COLUMN state_json TEXT;
