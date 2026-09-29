# C02 registry / C03 activation implementation report

Status: fix1 product files frozen for root re-review. C02 is not accepted or integrated by this report.

The current freeze includes publication CAS for delayed acquisition and legacy route fixtures backed by real SQL catalogs. See `task-C02-activation-fix1-report.md` for the current 59-path scope and verification: 4560 local tests pass, 1 skip, 0 fail; 45 final focused tests pass; four package typechecks pass. The original verification and root runtime evidence below are historical.

## Baseline and scope

- Accepted foundation HEAD: `976ddac4786766cb04764673fbbdab86b39793b1`.
- Worktree: `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption`.
- Sole implementation writer operated after root PRODUCT GO. No commits, push, deployment, live configuration changes, paid inference, full CI, or delegated agents were performed.
- Exact product scope: `task-C02-activation-owned.json` (59 paths after fix1; originally 24). Exact frozen bytes: `task-C02-activation-frozen-sha256.json`.
- All 10 hashes in `current-user-dirty-sha256.json` match. The four unrelated untracked product files (`PRODUCT.md` and the three Responses collaboration files) match `.baseline-manifest.json`; the manifest itself was not modified by this writer. Protected Responses changes are excluded from ownership.

## Delivered behavior

The stored-upstream registry now uses the accepted SQL catalog repository exclusively, with catalog code revision 5. Legacy KV snapshots cannot satisfy this identity. Independently constructible coordinators own separate bounded L1 maps and background sets, while SQL controls cross-instance leases, publication, persistent safe failures, and retry timing.

Automatic cold reads have a 20-second total budget and a 30-second SQL lease. Fresh snapshots last two minutes, stale snapshots remain usable during bounded background refresh and failure backoff, and cold SQL failures become unavailable. Cache-only editor reads perform no discovery. Explicit refresh joins the observed lease and accepts only its matching terminal token; an overwritten or superseded result produces `superseded-unavailable`. Failed refreshes retain successful snapshots.

Discovery rebuilds its provider and proxy transport from authoritative SQL observations. Publication is followed by a new authoritative read. Returned catalogs and dispatch bindings use accepted configuration, effective model filters, owner, provider, row incarnation, and caller visibility. A discovery provider owns the cancellation lifetime; a separate normal provider performs dispatch. Referenced proxy changes and explicit credential replacement invalidate the discovery identity; normal credential rotation and quota writes do not.

Stored Copilot discovery never publishes a catalog obtained with a request-token fallback. A stored row without a GitHub token, when a request token is available, follows the request-scoped catalog path without a SQL catalog row. The existing no-row Copilot fallback is also request scoped. Both request-scoped and stored discovery use bounded cancellation.

Editor routes retain ownership checks, allow owned disabled rows, apply accepted disabled-model flags, return 404 on an owner transfer during discovery, and preserve the catalog after explicit upstream errors.

L1 and background-refresh bookkeeping are each capped at 512 entries. A global observation epoch fences delayed pre-eviction reads without accumulating per-key tombstones. Publication versions order same-second updates.

## API, migration, and configuration changes

- New `CatalogCoordinator` accepts `catalogs`, `discover(observation, signal)`, `background`, `catalogRevision`, and optional bounded test policy; `read({ expected, mode, signal?, isVisible })` returns `{ upstream, proxies, snapshot } | null`. `CatalogDeadline` supplies actual cancellation and races non-cooperative work.
- Fix1 adds raw `CatalogObservation.publicationVersion` and optional `tryAcquire(..., { expectedPublicationVersion })`. Automatic/background readers atomically reject an intervening publication; explicit refresh retains its bypass.
- Registry `refreshModelsCache(upstream, options?)` and `readCachedModels(upstream, options?)` return accepted `CatalogResult | null`. Their options carry `signal` and `isVisible`; callers and fixtures were migrated from the former provider argument.
- Request middleware carries the actual `Request.signal` through `AsyncLocalStorage`, keeping protected Responses files untouched. Registry methods also accept an explicit signal override.
- `createPerRequestFetcher` gains an optional authoritative source for proxies and proxy backoffs; observed proxy rows can be used directly without consulting pinned request configuration.
- The root-approved additive `FetchLike` seam permits a readonly optional `signal`. `fetchWithRetry` combines it with `RequestInit.signal` before request execution and retry backoff. Discovery wrappers alone attach this signal. This fixes cancellation during Custom-provider backoff without leaking a discovery deadline into inference.
- Migration `0019_catalog_attempt_outcomes.sql` adds `completed_lease_token`, `completed_outcome`, `completed_error_code`, and `completed_publication_version`. Publish/failure writes update this single terminal slot atomically under the existing identity/lease fence. Generation replacement clears it. The normal schema-baseline update workflow regenerated the baseline.
- Repository `deleteInactiveRevisions` gains optional `maximumRevision`; its existing complete-active-set contract remains available. Production `sweepCatalogs` passes revision 5 as the upper bound.
- Optional `MODEL_CATALOG_ACTIVE_REVISIONS` is a JSON array containing the complete deployment inventory, with 1–32 unique positive safe integers including this isolate's revision. Missing or invalid values disable deletion. The existing scheduled maintenance path removes at most 128 rows unused for more than seven days, preserving live leases, active revisions, and all newer revisions. No live value was changed. See `vnext/docs/catalog-coordination.md`.

## Focused verification

All commands below ran from `vnext` unless stated otherwise. Final sessions exited 0 and logs are retained in this directory.

```sh
bun test packages/gateway/tests/catalog-repo.sqlite.test.ts packages/gateway/tests/catalog-coordinator.sqlite.test.ts packages/gateway/tests/catalog-maintenance.test.ts packages/gateway/tests/providers-registry.test.ts packages/gateway/tests/providers-registry-proxy.test.ts packages/gateway/tests/control-plane-upstreams.test.ts packages/gateway/tests/data-plane-per-request-dial.test.ts packages/gateway/tests/integration/catalog-outage.test.ts packages/gateway/tests/integration/catalog-discovery-errors.test.ts packages/gateway/tests/integration/shared-provider-state.test.ts packages/gateway/tests/dump-route-activation.test.ts packages/gateway/tests/mapped-model-catalog.test.ts packages/gateway/tests/migrations.test.ts packages/gateway/tests/responses-maintenance.test.ts packages/http/src/__tests__/fetch-retry.test.ts
```

Result: **262 pass, 0 fail, 2001 assertions across 15 files** in 13.76 seconds. Log: `task-C02-activation-focused-tests.log`.

```sh
bun run --filter @vibe-llm/gateway --filter @vibe-llm/platform-bun --filter @vibe-llm/platform-cloudflare --filter @vibe-core/http typecheck
```

Result: all four packages exit 0. Log: `task-C02-activation-typecheck.log`.

Owned TypeScript files were passed explicitly to the installed vnext ESLint. Result: **0 errors, 1 pre-existing warning** at `packages/http/src/fetch-retry.ts:103` (`preserve-caught-error` for the existing timeout wrapper). Log: `task-C02-activation-lint.log`. `git diff --check -- <all 24 owned paths>` passed, and the 10 protected hashes passed again at freeze.

Tests-first changes covered SQL terminal outcomes, coordinator behavior, authoritative proxy selection, and HTTP lifetime handling. Preserved RED evidence for the retry bug: `task-C02-activation-retry-red.log` records 21 pass / 1 fail, where an aborted injected-fetcher lifetime wrongly resolved after retry backoff; the focused final suite is green after signal composition.

Independent SQLite-handle tests cover one fetch across coordinators, canceled and timed-out losing waiters, abort-ignoring late results, persistent failure/backoff, lease takeover, configuration/proxy/owner changes, normal credential rotation, matching explicit outcomes versus overwritten attempts, publication versions, revision coexistence, the 512-entry L1 bound with delayed old-incarnation reads, and the separately bounded detached background set. Registry tests cover concurrent ALS request signals, request-token isolation, and dispatch lifecycle. C03 tests include cached GET, forced refresh, disabled owned rows, failure retention, and owner transfer. Maintenance tests include absent, invalid, active, and unknown newer revisions.

An earlier broad run had 260 pass / 2 fail because old shared-provider-state fixtures passed a fake provider through the removed refresh API. Those fixtures now publish via the actual catalog repository and prime L1 using `readCachedModels`; their 0-SQL / 0-HTTP quota-write assertions remain. That failed run attempted synthetic OAuth HTTP endpoints, so this report does not claim that all test execution was network-free. No real credentials or paid inference were used.

## Root-owned runtime evidence and acceptance

The following evidence was reported by root while files were still mutable; it is attributed context, not this writer's frozen runtime acceptance:

- Two workerd instances sharing real D1 and loopback HTTP: baseline two discoveries became one; both Responses dispatches returned 200 with independent dispatch lifetimes.
- Editor cache-only GET added no discovery; foreign ownership returned 404; explicit upstream HTTP 400 became gateway 502 while SQL/L1 snapshots remained.
- A request canceled at 200 ms returned catalog 503 at approximately 203 ms, closed the origin connection, and produced exactly one HTTP call with no snapshot. Root's rerun after the FetchLike lifetime fix removed the unwanted Custom retry log.
- Root's actual-D1 12-case matrix included terminal overwrite and takeover. The default-budget ignored discovery promise timed out at 20002 ms, had its owned signal aborted, and published no snapshot.
- Root is additionally exercising the actual-D1 maintenance wrapper gate.

Root owns independent review, frozen two-isolate HTTP/workerd/D1 reruns, full clean CI, final acceptance, and integration. This package is ready for those checks and is not a deployed or fully accepted C02 claim.

## Boundaries

- SQL timestamps retain one-second precision; monotonic publication versions supply ordering.
- Existing configuration authorization leases remain the visibility boundary. An L1 hit does not claim immediate knowledge of an unobserved remote revocation.
- A canceled joiner does not cancel another request's winning discovery or a shared credential exchange.
- A non-cooperative transport can outlive cancellation, but its discovery result cannot publish late. An SQL operation already submitted can finish after caller cancellation; the canceled caller does not install L1 or return its result.
- The single bounded terminal slot deliberately permits `superseded-unavailable` when the joined attempt's evidence has been overwritten.
- Revision cleanup is opt-in and inert by default. The deployment must provide a complete active revision inventory; unknown future revisions are always preserved.
- No full CI, final runtime acceptance, merge, push, or deployment was performed by this writer.
