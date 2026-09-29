# C02 catalog repository foundation evidence

Date: 2026-09-29. Accepted input revision: `a7c5adc039075871b3a86a7d94604f5639bc8a6b`.

This package adds discovery generations, authoritative SQL catalog identities, leases, atomic snapshot publication and persistent failure metadata. It does not yet activate the coordinator in registry discovery or C03 explicit refresh. The existing registry coordination flow remains until that separate package is accepted. The new stored generation already participates in its existing fingerprint, so editing configuration and reverting it no longer revives an older-generation catalog; C02 is not complete at this foundation checkpoint.

## Repository boundary

Migration 0018 adds per-upstream catalog generations and per-code-revision SQL catalog rows. Owner/provider/config/enabled/route changes invalidate the discovery generation. Referenced proxy URL and dial-timeout changes also advance it; display names, order, model filters, ordinary token rotation and quota/health writes do not. Built-in direct transports do not depend on same-named proxy rows. Snapshot publication increments a monotonic publication version for later L1 ordering even within one database-clock second.

The repository observes authoritative upstream and proxy configuration, rechecks the dependency generation and retries boundedly when it changed during observation. Lease acquisition, publication and failure use conditional SQL and immutable row incarnation; publication plus lease release is one update. Database time governs expiry. Inactive-revision cleanup is bounded and preserves declared active revisions and live leases. The caller must supply all revisions active during a rolling deployment; a running isolate's own revision is not that inventory.

`replaceCredentials` is a versioned CAS seam for later authorized import. It compares the previously read configuration, state, generation and target identity, then replaces config/state and advances generation exactly once in the same update. A competing state/config change returns contention; it does not replay an import blindly. Later import code must reread and verify credentialRevision before any bounded retry. This package adds no import route or UI and does not replace historical credentials automatically.

## Runtime acceptance

The retained driver uses actual local workerd and D1, two production D1Repo objects and the full migration corpus. A dependency-read interleaving wrapper forwards real D1 query results and changes a real proxy row between reads; it never manufactures SQL success or rows. All credentials and account labels are synthetic. No external HTTP, live provider, remote database or deployment is involved.

The final frozen-source [D1 result](result.json) passes: one acquisition winner, atomic publication, publication ordering, ownerless targets, takeover rejection of old success/failure, persistent restart backoff, explicit lease joining, five discovery-field fences, dependent proxy changes, bounded authoritative read rebasing, exact-timestamp recreation cleanup, versioned credential CAS, database-clock expiry, revision coexistence and bounded maintenance. [Product hashes](product-sha256.json) identify the implementation exercised.

Independent initial and scoped fix reviews approve this package. Final clean-checkout `bun run ci:local` passed with 4,487 tests passing, 1 existing skip and 0 failures; purity, all typechecks, lint (0 errors and 35 inherited warnings), dashboard build and Workers dry-run passed. The first full run exposed a time-dependent quota-only fixture that also changed token expiry; the minimal persisted-state correction passed 36 focused tests and independent review. These repository probes do not establish production one-fetch behavior across registry instances; that belongs to activation.

## Reproduction and consistency limits

```sh
VNEXT_PROBE_ROOT=/absolute/path/to/checkout node /absolute/path/to/evidence/runtime.mjs
```

Dependencies must be installed in that checkout. The driver explicitly resolves Miniflare 4.20260601.0 and Wrangler 4.97.0, creates isolated local storage, disposes its Miniflare instance and retains its scratch bundle. Dependency upgrades require updating this local harness.

The direct D1Database path is retained. Cloudflare's [read-replication contract](https://developers.cloudflare.com/d1/best-practices/read-replication/) says queries without Sessions API continue to run on the primary. In contrast, [first-primary session semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/) apply primary routing only to the initial query. These first-party documents were retrieved on 2026-09-29; local workerd acceptance does not measure geographic routing, replication or production latency.

Catalogs remain scoped to the upstream/account across configured egress routes, and the fingerprint hashes the full route policy. This preserves existing catalog scope; it assumes the configured routes expose the same upstream catalog rather than proving provider geographic invariance. A demonstrated location-specific catalog difference would require an explicit partition and catalog-code revision change.
