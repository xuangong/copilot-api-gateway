# C02 foundation fix1 report

Date: 2026-09-29. Base: `a7c5adc039075871b3a86a7d94604f5639bc8a6b`.

Root's clean `ci:local` yielded 4,486 pass / 1 skip / 1 fail. The sole failure was `gateway/tests/integration/shared-provider-state.test.ts:158`: remote quota write expected `configurationRevision` 1 but observed 2. Running that test file alone reproduced 8 pass / 1 fail with the identical assertion.

The remote-write fixture rebuilt `codexState()`. That helper uses `Date.now() + 3_600_000` for `accessToken.expiresAt`, so the new state differed in both quota and credential expiry. Existing migration `0010_configuration_revision.sql` removes `accounts[0].quotaSnapshot` for its state comparison but intentionally includes access-token expiry. The foundation migration's generation trigger compares upstream configuration and proxy references, not mutable `state_json`.

Deterministic reproduction used real `setupTestPlatform()` SQLite, fixed `expiresAt` values, and raw sibling-style `state_json` UPDATEs. It measured:

| Update | Revision before → after |
| --- | --- |
| Initial save | 0 → 1 |
| Quota plus expiry 4,000,000,000,000 → 4,000,000,001,000 | 1 → 2 |
| Quota alone, expiry held at 4,000,000,001,000 | 2 → 2 |

Diagnostic output: `{"revision0":1,"changedOutsideQuota":true,"revision1":2,"revision2":2}`. The test fix reads the saved authoritative state before changing only its quota snapshot. This is a two-line fixture correction; SQL, provider code and production behavior are unchanged.

The sole newly owned product path is `vnext/packages/gateway/tests/integration/shared-provider-state.test.ts`, SHA256 `0000201893e58326cdab38eeb9c9529095d575d572519b7cb0783ff220bdba13`. `task-C02-foundation-owned.json` lists all 13 exact product paths and `task-C02-foundation-frozen-sha256.json` lists their hashes. The 12 original product hashes and 10 `current-user-dirty-sha256.json` hashes remain unchanged.

Validation after fix: `bun test packages/gateway/tests/integration/shared-provider-state.test.ts packages/gateway/tests/catalog-repo.sqlite.test.ts` **36 pass / 0 fail / 156 assertions**, saved in `task-C02-foundation-fix1-focused-tests.log`; `bun run typecheck` exited 0 for all workspace packages; `git diff --check` exited 0. No full CI, workerd/D1 rerun, commit, push, deployment, credentials or external configuration changes were performed by this writer. Root retains those gates and scoped review.
