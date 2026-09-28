# D07 multi-select filter acceptance (2026-09-29)

The seven-file change on `18f73905` passed independent specification/quality review and one scoped accessibility fix review. Clean-tree `bun run ci:local` passed: 4170 tests, 1 existing skip, 0 failures; all types, purity, lint (36 inherited warnings), Dashboard build and Workers dry-run.

Real Chromium against a fresh Bun Gateway/SQLite fixture verified seven metric groups through the actual metrics route. Defaults success + stream yield 90 requests. Model a OR b with upstream a yields 24; adding error yields 41; clearing model alone yields 78. Literal unknown remains distinct from an empty/all filter. Keyboard selection, pressed states, and collapsed accessible summary references cover defaults, multiple choices, All and remembered stale labels. No page or console errors occurred, and the isolated listener was confirmed stopped.

One deliberately intercepted metrics response is held during Refresh and then returns empty groups. This tests selected option/label retention during the transient EMPTY state and after an empty result. It is explicitly a UI response fixture; all other metric operations use the real route and database. Clearing only key selection and restoring the real route yields 41 with other dimensions retained. Outcome counts are tested in pure state tests because the current screen does not render them.

To reproduce, copy archived text scripts to their original names, set `D07_SOURCE_ROOT` to a freshly built vNext checkout, and run `run.zsh`. The runner uses the locally installed Playwright path and an isolated environment. This is local synthetic acceptance, not production or deployed validation.
