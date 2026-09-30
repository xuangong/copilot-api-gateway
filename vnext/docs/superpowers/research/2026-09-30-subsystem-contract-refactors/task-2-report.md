# Task 2: Configuration authority and invalidation

Date: 2026-09-30. Worktree: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`.

Implemented the assigned source/test changes. No commit, Git index mutation, dependency installation, full CI, benchmark, deployment, Docker change or running-service replacement was performed. Root owns review, commits and integrated qualification.

## Contract changes

- `getDataPlaneConfiguration(): DataPlaneConfiguration` replaces the writable `getDataPlaneRepo()` surface. It exposes only the existing cached authorization/routing reads for keys, users, sessions, upstreams and proxies. Its nested methods are read-only types, and its runtime object does not forward unlisted methods to the raw repository.
- `ConfigurationCache.view`, `pinnedView()` and `freshPinnedView()` now return that narrow surface. No cached lookup was converted to a per-request SQL lookup. Normal snapshots retain their lease/pinning behavior; fresh socket admission retains a new authority check and uncached session lookup.
- Repositories without configuration revisions use `authoritativeConfigurationReads()` with the same narrow runtime surface. Their proxy health remains the prior direct raw repository; revision-enabled repositories retain the existing bounded proxy cache via explicit `getProxyHealth()`.
- Provider credential reads deliberately use the current cache, independently of request pinning. Their `saveState` commands remain authoritative CAS writes, and their recovery reads still refresh authority and update the current row cache. New SQLite coverage verifies local rotation, sibling recovery, old pinned routing reads and the next admission in one scenario.
- Non-configuration consumers now use explicit `getRepo()` authority: embeddings usage/timestamps, image performance and assigned-key grants. Catalog/affinity authority remains explicit in registry. The Task 3 owner separately migrated quota reads/writes.
- Shared credential resolution has a narrow configuration read type. HTTP API-key owner compatibility and WebSocket required-enabled-owner policy remain different; neither policy was changed. Control-plane prewarming still uses the raw repository outside request snapshots.

## Revocation fix and exhaustive classification

The actual logout route invokes `sessions.deleteByToken`. The prior observer listed `deleteByUserId` and `deleteExpired`, but omitted `deleteByToken`. SQL deletion succeeded and advanced the persisted revision while the process could continue admitting the cached session under its still-valid lease.

The observer now includes `deleteByToken` and has a mapped `ConfigurationMethodEffects` classification across every method of `apiKeys`, `users`, `sessions`, `upstreams` and `proxies`. The object uses `satisfies` so adding a repository method without a read/configuration-write/state-write classification is a compile error. Configuration writes invalidate in `finally`, preserving existing failed-write behavior. `saveState` keeps its row-level refresh path. `touchLastUsed` and private affinity-secret creation are explicitly classified as state writes outside the snapshot and do not invalidate it.

No migration or repository schema/type change was needed for this task.

## Files owned by this task

Source files:

- `packages/gateway/src/repo/configuration-ports.ts` (new)
- `packages/gateway/src/repo/configuration-cache.ts`
- `packages/gateway/src/repo/index.ts`
- `packages/gateway/src/shared/credential-auth.ts`
- `packages/gateway/src/control-plane/auth/session-auth.ts`
- `packages/gateway/src/data-plane/tools/web-search/resolve-for-key.ts`
- `packages/gateway/src/data-plane/dial/per-request.ts`
- `packages/gateway/src/data-plane/providers/registry.ts` (configuration import/calls only)
- `packages/gateway/src/data-plane/observability/attempts/embeddings-attempt.ts`
- `packages/gateway/src/data-plane/images/routes.ts`
- `packages/gateway/src/data-plane/alpha-search/routes.ts`
- `packages/gateway/src/data-plane/chat-flow/responses/session.ts`
- `packages/gateway/src/data-plane/models/routes.ts`
- `packages/gateway/src/data-plane/shared/gateway-ctx.ts`
- `packages/gateway/src/data-plane/chat-flow/shared/dump-open.ts`

Tests:

- `packages/gateway/tests/configuration-snapshot.test.ts`
- `packages/gateway/tests/configuration-fresh.sqlite.test.ts`
- `packages/gateway/tests/catalog-repo.sqlite.test.ts` (accessor rename only)
- `packages/gateway/tests/upstream-dto-races.sqlite.test.ts` (accessor rename only)
- `packages/gateway/tests/integration/shared-provider-state.test.ts` (accessor rename only)

This task did not edit `repo/types.ts`, quota/shared usage implementations or any of the 13 protected overlay files.

## Verification

Commands ran from `F/vnext` unless stated otherwise, with existing Bun 1.3.0 dependencies. TDD and systematic debugging were used for the reproduced regressions; verification-before-completion was used for the handoff.

### Red evidence before implementation

`bun test packages/gateway/tests/configuration-snapshot.test.ts -t 'logout revokes|pinned configuration exposes'`

- 0 pass, 2 fail, 14 filtered out, 7 assertions.
- Real SQLite-backed admission, followed by the actual logout handler, deleted the stored session but admitted the next request with 200 instead of 401.
- The pinned view still exposed the `apiKeys.save` command at runtime.

### Final affected behavior run

```text
bun test packages/gateway/tests/configuration-snapshot.test.ts packages/gateway/tests/configuration-fresh.sqlite.test.ts packages/gateway/tests/integration/shared-provider-state.test.ts packages/gateway/tests/upstream-dto-races.sqlite.test.ts packages/gateway/tests/data-plane/chat-flow/responses/session.sqlite.test.ts

87 pass
0 fail
340 expect() calls
Ran 87 tests across 5 files. [4.75s]
exit 0
```

Coverage includes the logout regression and runtime read-only port; warm configuration and healthy proxy operations with zero SQL; request pinning; bounded sessions and remote revision discovery; fresh checks that do not join pre-revocation pending work; provider live rotation/recovery; existing Codex/Claude sibling refresh races; no full reload for advisory quota writes; current HTTP/WS owner policies; WebSocket admission/next-turn revocation and existing session lifecycle cases.

Expected failure-path diagnostics appeared in the existing tests. There were no test failures.

### Static checks

- `bun x tsc --noEmit -p packages/gateway/tsconfig.json`: exit 0.
- Scoped ESLint over all 20 owned source/test files: exit 0, only the existing multi-project parser advisory.
- `git diff --check`: exit 0.
- `rg -n 'getDataPlaneRepo' vnext/packages`: no matches after coordinated quota migration. Historical research/plan references were left unchanged.
- SHA-256 comparison against `baseline.json`: 13 protected files checked, 13 unchanged.

An intermediate test import/typecheck failed only while the separately owned quota module still referenced the removed accessor; its owner completed that coordinated migration before the successful commands above.

## Remaining boundaries

The architectural result is a narrower capability contract and immediate local logout invalidation. It does not claim a measured CPU/heap/latency improvement, stricter HTTP owner policy, instant cross-instance revocation, changed authorization lease timing or a new credential persistence design. Full CI, independent review and exact-artifact resource measurement remain root-owned integrated/follow-up gates.
