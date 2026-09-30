# Task 1 report: Catalog retention owner

Date: 2026-09-30.

Implemented only in `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`. The existing overlay was not edited. No Git operations, commits, dependency installs, deployment, Docker replacement, service stop, full CI or performance measurements were performed. The root owns review, serialized commits and integrated qualification.

## Files

- Modified `vnext/packages/gateway/src/data-plane/providers/catalog-coordinator.ts`.
- Added `vnext/packages/gateway/src/data-plane/providers/catalog-retention.ts`.
- Added `vnext/packages/gateway/tests/catalog-retention.sqlite.test.ts`.
- Added `vnext/packages/gateway/tests/catalog-retention.test.ts`.
- Added this report. No plan, registry, formal research, spec or unrelated source file was changed.

The existing `catalog-coordinator.sqlite.test.ts` was exercised without edits.

## Behavior and semantic choices

`CatalogCoordinator.read(request): Promise<CatalogResult | null>` remains unchanged. The coordinator now delegates shared memo ownership to `CatalogRetention`, which accounts for entry count, accepted model count and estimated bytes across retained entries.

Policy options are `retainedEntries`, `retainedModels` and `retainedBytes`. Their defaults and maximum accepted values are 512, 16,384 and 16 MiB respectively, matching the routing projection ceilings. Each can be reduced to zero. Non-integer, negative, non-finite or above-ceiling values are rejected. A zero model budget can still retain an empty/error memo, but populated catalogs remain request-local; zero entries or bytes disable retention entirely.

The byte estimate visits the full memo graph, including accepted models, identity, upstream row/state and proxies, without serializing another JSON copy. Object identity is counted once within an entry, while equal strings and objects referenced by multiple entries are conservatively counted per occurrence/entry. The estimate uses the same broad string/object/key sizing style as routing projection accounting and includes an entry overhead allowance. It stops when the entry cannot fit. This is a deterministic accounting estimate, not a measurement of the JS heap or resident memory.

The owner only admits plain JSON-shaped graphs. Functions, symbols, accessor properties, unexpected prototypes, symbol keys and hidden non-enumerable state are not retained. Accessors are rejected without invoking them. Arrays' ordinary non-enumerable `length` is permitted. These checks prevent executable request capabilities from being hidden in retained metadata; providers, fetchers, signals, visibility callbacks and background executors are not part of the memo shape.

All removal paths use the same stored reservation: ordinary replacement, budget eviction, explicit `clear()`, and removal after an ineligible authoritative observation. Oversized replacement removes the previous reservation for that upstream without evicting unrelated entries merely to try to fit an individually oversized value. Aggregate eviction preserves the prior insertion/replacement ordering; this change does not introduce access-based LRU semantics.

An accepted oversized catalog remains available to the request that read it. It is still persisted under the existing lease/CAS rules and returned for automatic and explicit requests; only shared retention is skipped. Retention failure does not turn a valid catalog into an invalid-catalog error. A later read can load it again from authority; it cannot use an L1 fallback after the SQL authority becomes unavailable.

When an identity is evicted or cannot be retained, the coordinator updates the existing bounded global installation fence. It does not allocate per-evicted-identity tombstones. Existing ticket, incarnation, configuration-generation, publication-version and explicit-joined-terminal checks remain in place. A delayed smaller publication cannot reinstall after a newer oversized accepted publication has displaced it.

Warm reads now construct a local memo/result view with `request.expected`; they never assign that request row back into shared retention. The current request receives its current credentials/configuration view, while mutating that returned request row cannot rewrite the retained authoritative row. The regression demonstrates this using real SQLite and a subsequent authority outage.

The `CatalogResult.snapshot` contract now explicitly says the accepted publication is shared read-only data for every reader, including cache-only/admin callers. Callers must copy before editing. The helper likewise documents that accounting assumes retained graphs are not expanded in place. It deliberately does not deep-freeze upstream credential/state objects. Registry projection already freezes the model graph; this change introduces no new freeze behavior or provider-preparation restriction.

Discovery modes, background refresh ownership/caps, deadlines, lease acquisition, publication CAS, retry/backoff, cancellation and credential/proxy renewal remain on their existing call paths. No request provider or fetcher closure is added to retention.

## Red/green evidence

Commands below ran from `F/vnext`, where `F` is the worktree above, using existing dependencies and Bun 1.3.0.

### Initial regression run, before production edits

```text
$ bun test packages/gateway/tests/catalog-retention.sqlite.test.ts
3 pass
7 fail
21 expect() calls
Ran 10 tests across 1 file. [447.00ms]
exit 1
```

The seven failures were the intended missing behaviors:

1. Aggregate model retention did not evict before the 512-entry limit.
2. Aggregate estimated bytes did not evict metadata-heavy catalogs.
3. Oversized automatic success remained incorrectly retained.
4. Oversized explicit success remained incorrectly retained.
5. Byte-oversized success remained incorrectly retained.
6. A warm request row could replace shared authority and prevent a later eligible fallback.
7. A newer oversized publication remained retained, defeating its request-local-only contract.

The existing replacement, clear and ineligible-removal scenarios passed initially; they are preservation/accounting regressions, not claimed as initially missing behavior.

### First implementation run

```text
$ bun test packages/gateway/tests/catalog-coordinator.sqlite.test.ts packages/gateway/tests/catalog-retention.sqlite.test.ts
28 pass
0 fail
1113 expect() calls
Ran 28 tests across 2 files. [5.74s]
exit 0
```

Additional SQLite boundary coverage then exercised a lowered entry cap, upstream-state bytes outside models, oversized replacement without collateral eviction, and each zero-budget mode. The intermediate run had 34 pass, 0 fail and 1126 assertions.

### Hidden-capability regression

The first helper implementation rejected enumerable functions, accessors and non-JSON objects, but could retain a function hidden in a non-enumerable property. A focused owner test demonstrated this before the additional own-property-shape guard:

```text
$ bun test packages/gateway/tests/catalog-retention.test.ts
2 pass
1 fail
10 expect() calls
Ran 3 tests across 1 file. [52.00ms]
exit 1
```

The failing assertion expected the metadata graph with a hidden `fetcher` closure to be absent. The guard now rejects hidden and symbol-keyed state without evaluating it.

### Final targeted tests

```text
$ bun test packages/gateway/tests/catalog-coordinator.sqlite.test.ts packages/gateway/tests/catalog-retention.sqlite.test.ts packages/gateway/tests/catalog-retention.test.ts
37 pass
0 fail
1137 expect() calls
Ran 37 tests across 3 files. [6.99s]
exit 0
```

This includes all 18 pre-existing coordinator scenarios: independent SQL lease sharing, canceled loser detachment, abort-ignoring late discovery, persistent backoff, ownership/configuration changes, cache-only behavior, explicit joined terminal attribution, takeover publication, delayed old incarnation after eviction, credential/proxy renewal, bounded detached background refresh, captured request executors, same-second versions and independent catalog revisions, and delayed acquisition in four modes.

It also includes 16 SQLite retention cases and three pure owner cases. SQLite tests use a real temporary database; proxies in concurrency scenarios only delay real repository reads and do not mock database results.

### Final scoped typecheck and lint

```text
$ bun run --filter '@vibe-llm/gateway' typecheck
@vibe-llm/gateway typecheck: Exited with code 0
```

```text
$ bun ./node_modules/eslint/bin/eslint.js packages/gateway/src/data-plane/providers/catalog-coordinator.ts packages/gateway/src/data-plane/providers/catalog-retention.ts packages/gateway/tests/catalog-retention.sqlite.test.ts packages/gateway/tests/catalog-retention.test.ts
Multiple projects found, consider using a single `tsconfig` with `references` to speed up, or use `noWarnOnMultipleProjects` to suppress this warning
exit 0
```

The lint output is the existing multi-project parser advisory; there were no file diagnostics.

## Limits and handoff

- This bounds coordinator-owned retention under its read-only graph contract. It does not bound active request graphs, oversized request-local catalogs, background discovery work, other caches, other isolates or the entire runtime heap.
- SQL persistence and discovery still materialize catalogs as before. Skipping L1 retention can increase authority reads for large catalogs; no latency or throughput improvement is claimed.
- No additional global cache, queue, physical store, schema or protocol change was introduced.
- The new byte estimator inspects entries on installation, not on ordinary retained hits. Its cost and the conservative reservation model have not been benchmarked.
- Root review and integrated qualification remain outstanding. This task did not create or commit a Git change; the root can commit only the four listed source/test files after review.
