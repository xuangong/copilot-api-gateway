-- Promote github_accounts into a unified-upstream shape without renaming the
-- table or breaking existing query paths. Each (user_id, owner_id) row is
-- one Copilot upstream; future custom/azure providers can land as separate
-- tables or new rows once we add a provider column.
--
-- Columns added:
--   enabled         on/off flag for routing/selection (defaults on)
--   sort_order      priority for selection (lower = higher priority)
--   flag_overrides  JSON object {flagId: bool} for per-upstream feature gates
--   updated_at      change tracking; backfilled to created-at-equivalent NULL

ALTER TABLE github_accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE github_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE github_accounts ADD COLUMN flag_overrides TEXT NOT NULL DEFAULT '{}';
ALTER TABLE github_accounts ADD COLUMN updated_at TEXT;
