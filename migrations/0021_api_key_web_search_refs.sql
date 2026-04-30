-- Borrow references for web-search secret fields. When a *_ref column is set,
-- the corresponding *_key column MUST be NULL.
--
-- Intentionally NOT enforced at schema level:
--   * XOR (literal vs ref) is enforced by the PATCH /api/keys/:id handler, not
--     a CHECK constraint, so the routes own the user-facing 400 error.
--   * No FOREIGN KEY to api_keys(id): the resolver re-checks visibility on every
--     call and surfaces dangling refs as { broken: true } in GET /api/keys so
--     the borrower can clean them up. ON DELETE SET NULL would silently strip
--     that signal.
--
-- Resolver rehydrates the source key value at request time (5-min TTL cache,
-- per-borrower invalidation on PATCH/copy-from).
ALTER TABLE api_keys ADD COLUMN web_search_langsearch_ref TEXT;
ALTER TABLE api_keys ADD COLUMN web_search_tavily_ref TEXT;
ALTER TABLE api_keys ADD COLUMN web_search_ms_grounding_ref TEXT;
