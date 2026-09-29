# Codex quota observation delivery

C09 retains the last quota observation with a fixed freshness horizon and exposes a session-authorized read-only endpoint and account panel. Missing values remain unknown; observed zero is shown as zero. Actual future rate-limit rejection remains the dispatch gate, independently of display freshness or utilization.

## Accepted evidence

- Frozen implementation: 13 product/test files; independent spec and quality review approved.
- Focused tests: 93 pass, 0 fail, 339 assertions, including real SQLite gating/authentication and late-request cancellation.
- Root complete CI: 4730 pass, 1 existing skip, 0 fail; purity, workspace types, lint, UI build and Workers dry-run pass. Lint retains 35 preexisting warnings plus its informational multiple-tsconfig notice.
- Actual local workerd/app/D1: session-only access, owner/admin authorization, equivalent foreign/missing 404s, stale observations, unknown versus zero, fixed horizons, malformed-data sanitization, zero state writes, and zero outbound requests with a seeded Copilot prewarm trap and expired Codex credentials.
- Actual Chromium/Bun/app/SQLite: stale/unknown/zero/fresh display, independent reload, zero credential refresh, zero outbound requests, no model reload, unchanged persisted state and no browser errors. Screenshot inspected.
- The initial accepted baseline returned 404 for the absent quota route; frozen implementation passes.

## Scope and reproduction

Synthetic credentials and temporary databases only. No live provider, production account, deployment, or configuration was used. The browser fixture blocks external fetch and raw socket traffic. Python Playwright was unavailable; the existing official Node Playwright installation runs equivalent isolated browser checks.

`runtime.mjs` uses `VNEXT_PROBE_ROOT` and actual local workerd/D1. `browser-fixture.ts.txt` and `browser-run.sh.txt` are archived runnable source (restore original suffixes in a scratch directory). The browser harness uses an existing local Playwright path, which must be adjusted on another machine. No migration, dependency or environment configuration changes are required.

C08 credential CAS and other global invariants remain in their accepted implementations; C09 does not modify credential writes, dispatch gating, retention, or provider-call identity. Complete CI includes those regressions. The reader performs no credential write on either runtime fixture.
