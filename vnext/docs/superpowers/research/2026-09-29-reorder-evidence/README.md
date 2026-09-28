# D06 reorder acceptance (2026-09-29)

The nine-file change on `8adb2831` passed independent specification/quality review, a scoped correction review, and clean-tree `bun run ci:local`: 4163 pass, 1 existing skip, 0 fail; types, purity, lint (36 inherited warnings), UI build and Workers dry-run passed.

Eight isolated Chromium scenarios use the real Bun Gateway and fresh SQLite with synthetic owner/foreign rows: upstream pointer, arrow buttons, focused-handle keyboard, owner/enabled boundaries, Escape, failed save, queued intent after failure, and mapping draft. All passed with zero browser page errors. Mapping verifies pointer movement, no write before Save, Cancel/Escape, both handle arrow keys, and one final mapping PATCH. Upstream persistence is checked against the database and page reload. Each fixture listener was confirmed stopped.

The first review exposed failed compensation after partial reindexing. The controller now reconciles authoritative order before rebasing remaining intents; a focused regression covers the exact sequence. Mapping pointer gestures originally failed to emit native drag events; Pointer Events and stable destination row IDs now handle them. The delayed-failure fixture also required an independent held-response release reference; expected ordering was unchanged.

Archived runners require a built checkout via `D06_SOURCE_ROOT` and the locally installed Playwright path. Copy text artifacts to their original names in scratch, then run each named scenario from `browser-results.json`. No real account, production database, deployment, or hosted provider is involved.

A nonblocking review follow-up remains: sustained reconciliation failures need lifecycle cancellation/backoff and notification deduplication. It is tracked for the final branch review.
