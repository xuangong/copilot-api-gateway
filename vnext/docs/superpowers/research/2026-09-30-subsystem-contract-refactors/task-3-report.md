# Task 3 implementation report

## Result and scope

Implemented the quota-specific aggregate repository projection and migrated the monthly gate. No schema, pricing, quota policy, host, or deployment change. No commits, Git mutations, installations, or service changes were performed by this worker.

Files owned by this task:

- `vnext/packages/gateway/src/repo/types.ts`: `UsageQuotaQuery`, `UsageQuotaProjection`, and `UsageRepo.queryQuota`.
- `vnext/packages/gateway/src/repo/usage-quota.ts`: fixed-size SQLite/D1 aggregate projection.
- `vnext/packages/gateway/src/repo/shared/repos.ts`: shared repository method wiring only.
- `vnext/packages/gateway/src/data-plane/observability/quota.ts`: aggregate admission and rounding-sensitive legacy recheck. Configuration reads use Task 2's `getDataPlaneConfiguration`; usage uses authoritative `getRepo`.
- `vnext/packages/gateway/tests/repo-quota-projection.sqlite.test.ts`: real SQLite parity, resource-shape, selective-read, and gate regressions.

Original collaboration overlay files were not edited. `repo/index.ts`, `configuration-cache.ts`, and `providers/registry.ts` were not edited by this worker.

## Contract and query behavior

The default repository query returns requests, six known token dimensions, and resolved known cost, plus fixed-size floating-point error metadata. The gate explicitly selects the metrics configured on the key:

| Configured quota | Storage read |
| --- | --- |
| None / unknown key | No usage query |
| Requests only | One aggregate over `usage_requests`; no dimension-table scan |
| Tokens only | One dimension aggregate; no request-count read, price column, or fallback lookup |
| Cost only | One dimension aggregate with recorded-price fallback; no request-count read or unused token sums |
| Combined | One SQL statement combining the necessary aggregates |
| Floating-point threshold neighborhood | Aggregate followed by the original two detail reads and ordered JS computation |

All scope parameters are SQL bindings. Known dimension names are static protocol constants. UTC filtering remains `hour >= start AND hour < end` for the requested key. Requests remain independent of token rows. Unknown dimensions do not contribute token or cost totals.

Historical null cache/image prices resolve against the input/output price in the complete original bucket: key, incoming model, target model, null-normalized upstream, model key, client, and hour. `COALESCE` preserves known zero. No fallback leaks across neighboring buckets. Counts use REAL accumulation to avoid SQLite's integer-sum overflow mode; this remains JavaScript-number arithmetic rather than introducing a new integer/decimal accounting policy.

## Floating-point compatibility exception

SQL aggregation can reassociate sums. Exact old admission decisions are preserved near token/cost thresholds by rerunning the previous `usage.query` + ordered `computeWeightedTokens` / `recordCostUsd` fold. The gate uses known-dimension row count and absolute token/cost term totals to form a conservative forward-error envelope: `gamma((16n + 64) * EPSILON) * magnitude`, with a subnormal allowance. The operation count covers products, per-bucket additions/division, both aggregate folds, and the magnitude estimate; `EPSILON` is twice unit roundoff. Non-finite or excessively large bounds force recheck.

This exception intentionally retains full-month materialization at a rounding-sensitive threshold. It does not claim bounded detail memory for every configured-quota request. Like the previous two-query soft-quota path, this is not a reservation or a transactionally frozen admission snapshot.

Regression examples verified against real stored usage:

- Ten `$0.1` buckets preserve the old `0.9999999999999999 < 1` allowance.
- Six one-token cache reads preserve the old `0.6 < 0.6000000000000001` allowance.
- Exact token and cost limits still deny after recheck.

Requests -> tokens -> cost denial order, reason templates, UTC Retry-After, and fail-open behavior remain intact.

## Red/green evidence

Initial focused red command:

```sh
bun test packages/gateway/tests/repo-quota-projection.sqlite.test.ts
```

`task-3-red.log`: 1 pass / 9 fail. The existing no-quota path passed; missing projection and old detail-read structure caused the intended failures. An earlier loader attempt hit the concurrently removed `getDataPlaneRepo` export; this was fixed by the coordinated getter migration before capturing the valid red evidence.

Selective-read red: `task-3-selective-red.log`, 11 pass / 2 fail, specifically missing `usage` / `usage_requests` when the obsolete implementation unnecessarily accessed each table.

Final green command:

```sh
bun test packages/gateway/tests/repo-quota-projection.sqlite.test.ts packages/gateway/tests/repo-usage.test.ts packages/gateway/tests/observability/quota.test.ts packages/gateway/tests/observability/dispatch-quota.test.ts
```

`task-3-green.log`: **33 pass / 0 fail, 116 expectations, four files**. Includes the existing real-dispatch 429 test. New coverage verifies known zero, unknown dimensions/prices, all fallback classes, image/cache weights, multiple models/hours, complete identity isolation, null/empty upstream equivalence, NUL-containing identities, independent token/request buckets, key scoping and end-exclusive range.

Focused ESLint over the five owned source/test files passed (`task-3-lint.log`); only the existing resolver advisory about multiple projects appeared. Tracked-file `git diff --check` passed. Gateway typecheck is coordinated with Task 2/root instead of duplicated here. Full CI remains root's final integration responsibility.

## Resource evidence and limits

The real executor instrumentation executes every SQL statement against SQLite; no database mocks are used. A fixture of 120 hour/model buckets returns **360 dimension rows + 120 request rows** on the old query, compared with **one SQL result row** on the projection. Ordinary configured-quota admissions also return one row. Rounding-sensitive cases explicitly return the aggregate and both detail result sets.

This establishes bounded transfer and Worker-side projection shape for ordinary requests. It does not measure Cloudflare CPU, latency, heap, D1 scanned rows, or fleet concurrency. Price fallback remains a correlated lookup using the full identity; D1 query plans and realistic local-workerd resource comparisons remain the exact-artifact qualification gate. No production performance improvement is claimed.

## Remaining integration work

- Root independent review and the coordinated final typecheck/CI.
- Root's scoped commit and authorized local `vNext` integration.
- Separate local-workerd resource comparison before any production decision.

No functional blocker was found for this slice.

## Review follow-up: request denial precedes floating-point recheck

An already-exceeded request quota now returns its existing higher-priority denial directly after the aggregate, before any token/cost precision recheck. A real SQLite regression with requests exceeded and both numeric metrics exactly at their limits records one aggregate row and no detail reads. When the aggregate did not deny and a numeric recheck reads a later usage snapshot, the existing post-recheck request check remains to preserve priority if concurrent usage has since crossed that limit.

`task-3-request-priority-red.log`: 0 pass / 1 fail, with the old implementation performing the two unnecessary detail reads. Final focused green command unchanged: **34 pass / 0 fail, 118 expectations** in `task-3-green.log`. This supersedes the earlier 33-test count above.
