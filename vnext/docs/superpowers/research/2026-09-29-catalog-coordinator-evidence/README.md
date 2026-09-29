# C02 catalog coordinator activation evidence

Date: 2026-09-29. Accepted input revision: `976ddac4786766cb04764673fbbdab86b39793b1`.

This package activates the SQL catalog repository for production registry discovery and explicit editor refresh. Automatic cold calls coordinate across instances; stale calls return the accepted catalog and schedule a detached refresh. Cache-only editor opening makes no upstream request. Discovery uses the authoritative row and proxy configuration, while ordinary dispatch owns a separate fetcher lifetime. Code revision 5 excludes the former KV projection.

## Concurrency and failure contract

The SQL lease defaults to 30 seconds. One 20-second budget covers observation, lease acquisition, discovery, publication and waiting, with actual cancellation propagated through fetch retry backoff. Automatic acquisition checks the raw observed publication counter atomically, so another instance's intervening fresh publication is reused. Explicit refresh intentionally bypasses this observation counter check, joins an existing live lease, and only attributes a terminal result to that exact token. Overwritten joined evidence becomes `superseded-unavailable`. Failed discovery retains the accepted snapshot and persists backoff.

Migration 0019 adds one bounded terminal token/outcome per catalog row. No permanent attempt log is stored. L1 and background-refresh bookkeeping are bounded to 512 entries; an eviction fence prevents late observations from reviving retired entries. Cleanup runs through the existing scheduler only when `MODEL_CATALOG_ACTIVE_REVISIONS` supplies the complete active revision inventory. Missing or malformed policy skips cleanup; unknown newer revisions and live leases are preserved. The production sweep deletes at most 128 rows idle for seven days.

## Actual runtime acceptance

[Coordinator result](coordinator-result.json) exercises actual local workerd, D1, production repository/coordinator code, and the complete migration corpus. It passes independent-instance one-fetch, a delayed acquirer after another instance published, loser cancellation, abort-ignoring late result rejection, persistent backoff and explicit recovery, in-budget configuration rebasing, owner replacement, authoritative proxies, code-revision coexistence, overwritten terminal evidence, lease takeover, stale background refresh, and production cleanup with future-revision protection. The unmodified production default deadline measured 20,002 ms and aborted the discovery signal without publishing.

[Registry baseline](registry-baseline-result.json) on the accepted foundation made two concurrent discovery HTTP calls. The [activated registry result](registry-result.json) uses two actual workerd isolates sharing D1 and a real loopback HTTP server: concurrent cold calls make one discovery before release, both ordinary Responses dispatches then succeed, cache-only editor opening adds no discovery, and a foreign owner receives 404. A later explicit refresh deliberately makes the second discovery and returns its HTTP failure while keeping the SQL/L1 catalog.

The same HTTP fixture aborts the actual app Request signal after 200 ms. The route returns 503 at about 205 ms; the origin observes connection closure, only one discovery HTTP call occurs, and no snapshot is published. The former retry-backoff log is absent after the owned-fetcher signal fix. This measures local app Request cancellation and actual loopback transport; it does not establish production Cloudflare client-disconnect behavior, cross-region latency, or live provider behavior.

## Review and verification

Initial review found a delayed-acquisition race; an independent real-SQLite reproduction and root's actual-D1 failure variant established duplicate discovery and an erroneous unavailable response despite a fresh catalog. The fix adds publication-counter CAS for automatic/background acquisition. Its real-SQLite tests also cover stale background and unchanged explicit-refresh semantics.

The first complete CI run exposed 190 failures in older route/e2e fixtures that lacked persisted catalog identities. The test-only adapter now runs the actual migrated SQL repository while retaining original route assertions, source filters/mutations, and spies. Stored Copilot fixtures have their own synthetic token exchange. No production discovery fallback was introduced. See the implementation and fix reports for exact targeted commands and historical failures. Final frozen clean-checkout `bun run ci:local` passed: 4,514 tests pass, one existing skip, zero failures; purity, all typechecks, lint (zero errors; 35 inherited warnings), dashboard build and Workers dry-run pass. Initial review and scoped fix review now approve the completed package; the delayed-acquisition finding and fixture incompatibilities are addressed.

## Reproduction

```sh
VNEXT_PROBE_ROOT=/absolute/path/to/checkout MEASURE_DEFAULT_BUDGET=1 node /absolute/path/to/evidence/coordinator-runtime.mjs
VNEXT_PROBE_ROOT=/absolute/path/to/checkout node /absolute/path/to/evidence/registry-runtime.mjs
```

The checkout must have its dependencies installed. The drivers resolve the pinned Miniflare 4.20260601.0 and Wrangler 4.97.0, use isolated synthetic credentials/storage/loopback transports, dispose owned services, and retain scratch bundles. [Product hashes](product-sha256.json) identify the final candidate; [initial hashes](initial-product-sha256.json) identify the candidate reviewed before the fix. No push, deployment, live credential change or paid model call is part of this acceptance.

The accepted foundation's primary-read and upstream/account-scope boundaries still apply: configured egress routes are assumed to expose the same upstream catalog. Local evidence does not prove geographic catalog invariance or remote D1 replication behavior. See the [foundation evidence](../2026-09-29-catalog-repository-evidence/README.md).
