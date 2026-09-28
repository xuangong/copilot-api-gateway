# D08 selected-key quota consumer acceptance (2026-09-29)

The eleven-file consumer package on `f90673dd` passed independent spec/quality review and root clean `bun run ci:local`: 4190 passed, 1 existing skip, 0 failed; all type/purity/lint (36 inherited warnings), UI build and Workers dry-run gates passed. Focused real-SQL/API/state checks: 9 tests, 84 assertions, including 28/29/30/31-day UTC months, Dec/Jan and exclusive end.

Root real Chromium + Bun Gateway + migrated SQLite acceptance passed with zero browser errors. Selected owned key: 5 requests, 348 weighted tokens, USD 0.00004792; assigned key: 11 requests, 382.5 weighted tokens, USD 0.000027; empty key: zero. Keys made 11 overview requests and zero selected-key detail requests. Separate direct fixture comparisons and the unchanged UsageTab still call detail, and are not included in that Keys-only zero count.

Important intentional correction: the old ordinary-session detail route ignores `key_id` and returns 16 combined owned+assigned requests in this fixture. The new overview intersects the selected key correctly. Arithmetic parity is established for the same selected data using a synthetic admin legacy-detail oracle and direct SQLite fixtures; unconditional old ordinary-session visible-number parity is not claimed. No cross-owner leak was demonstrated. The legacy route is a separate follow-up fix.

Delayed A-to-B and repeated same-key requests cannot overwrite newer results. Failed first loads show unavailable metrics and a retry button, not zeros. Same-key refresh/error retains clearly marked previous data; successful empty month alone renders zero. Limits remain editable and saving them refetches totals. Browser UTC preference does not alter UTC quota month. Two held responses and two synthetic 503 responses are deliberate loopback controls; all normal data/auth paths use the real app and database.

Root inspected the cropped ready/error screenshots; both exclude key secrets and show only the quota panel. Fixture process/listener stopped after cleanup. Full browser acceptance ran before capture, then reran unchanged assertions to collect these visual artifacts. No production runtime was contacted.

To reproduce, restore scripts from `.txt`, set `D08_SOURCE_ROOT` to a freshly built checkout's `vnext`, and run `run.sh`. The locally installed Playwright path is reused. Synthetic runtime connection files/databases remain untracked and are not archived.

The panel consumes only the full overview total, including non-cancelling unknown-price metadata. Quota enforcement and UsageTab remain unchanged. Raw enforcement arithmetic for signed historical quantities differs from the positive display projection; this package preserves same-scope dashboard arithmetic and does not claim to unify accounting. Full D08 UsageTab migration remains queued.

## Later legacy-route correction

The subsequent [detail-filter correction](../2026-09-29-usage-detail-filter-evidence/README.md) fixes the ordinary-session endpoint to return 5 for the selected owned key. This directory preserves pre-fix acceptance at `9fd40412`; restore that revision when reproducing its historical assertion of 16. The selected-key quota overview/UI assertions remain valid.
