-- Path B (VS Code token paste) support: track which GitHub host each account
-- belongs to (github.com vs <tenant>.ghe.com) and how the token was obtained.
--
-- github_host = "github.com" for legacy device-flow rows; per-tenant hostname
--   (e.g. "msft.ghe.com") for paste imports.
-- source      = "device-flow" for the classic OAuth flow, "paste" for tokens
--   the user extracted from VS Code's safeStorage and pasted in.

ALTER TABLE github_accounts ADD COLUMN github_host TEXT NOT NULL DEFAULT 'github.com';
ALTER TABLE github_accounts ADD COLUMN source TEXT;
