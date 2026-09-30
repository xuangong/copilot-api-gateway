# Integration CI correction: configuration/catalog boundary

Status: complete; one test file frozen for root review. Date: 2026-10-01.

## Root cause

The integration failure is a test migration omission. `ConfigurationCache.pinnedView()` now returns the narrow `DataPlaneConfiguration` port. Its runtime `createView` exposes only apiKeys/users/sessions/upstreams/proxies reads, with no catalog capability. `getRepo()` remains the live authoritative repository, and the real provider registry constructs its coordinator with `getAuthoritativeRepo().catalogs`. Reintroducing catalogs to the pinned port would violate the intended Task 2 boundary.

The existing `catalog reads bypass a pinned configuration view` test still accessed `pinned.catalogs.read`. Its isolated reproduction failed exactly at that access with `TypeError: undefined is not an object`. Inspection of the full test file found no other old pinned catalog usage; the existing credential replacement test already uses the new configuration accessor correctly.

## Correction

Only `vnext/packages/gateway/tests/catalog-repo.sqlite.test.ts` changed. The renamed test `pinned configuration keeps old metadata while authoritative catalogs read sibling writes` keeps the original two-connection, file-backed SQLite fixture. It now reads the catalog explicitly through `first.catalogs`, the authoritative repository underlying the cache, after the second connection changes metadata. Assertions verify:

- The pinned port has no catalogs capability.
- Pinned upstream metadata remains enabled at its previous catalog generation.
- The authoritative catalog sees the sibling's disabled row and incremented configuration generation.

No source changes, new ports, database mocks, additional test files, or expanded suite were introduced.

## Verification

- Original focused reproduction: **0 pass / 1 fail / 27 filtered**, matching the CI failure (`integration-ci-fix-red.log`).
- Entire affected file: **28 pass / 0 fail / 144 assertions** (`integration-ci-fix-green.log`).
- One-file ESLint: exit 0, no findings (`integration-ci-fix-lint.log`).
- `git diff --check` on the changed file passed.

Review artifact: `integration-ci-fix.diff`. Frozen SHA-256: `integration-ci-fix-hashes.json`. No Git writes or broader CI rerun were performed; root owns integration review and commit.
