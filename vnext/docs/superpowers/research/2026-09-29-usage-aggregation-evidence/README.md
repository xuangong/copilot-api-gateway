# D08 bounded usage aggregation evaluation

Date: 2026-09-29. Recommendation: **defer replacing the production usage path**. A safe, implementable SQL overview reduces materialized rows and process peak RSS in the synthetic full-range case, but was consistently slower. Keep `repo.usage.query` plus `aggregateUsageForDisplay` until a bounded endpoint passes the authorization/semantic matrix and a Workers/D1 plus dashboard workload demonstrates a useful end-to-end benefit.

## Source contract checked

- `SharedUsageRepo.query` loads dimension and request rows separately and `assembleUsageRecords` reconstructs full storage buckets before the display collapse. `recordCostUsd`/`unitPriceForDimension` applies read-time fallback from cache read/write and input image to same-bucket input, and output image to same-bucket output. Null unresolved prices contribute zero cost; explicit zero remains priced. Full identity includes key, incoming model, model, normalized upstream, model key, client, and hour. See `vnext/packages/gateway/src/repo/shared/repos.ts`, `shared/usage-cost.ts`, and `vnext/packages/protocols-llm/src/common/index.ts`.
- `token-usage/routes.ts` has four scopes: admin, API key (takes precedence over a coexisting session), user owned plus assigned, and shared view owned-only with HMAC redaction. An overview must reuse this route resolution and key/owner/name/participant enrichment. SQL aggregation alone does not establish route authorization equivalence.
- `buildKeyIdRangeQuery` drops an explicitly empty `keyIds` list and falls back to all keys. The existing route returns early for empty user/shared scope. A new overview repository method must return empty for `keyIds: []` itself; it must not borrow that helper unchanged.

## Reproducible synthetic experiment

`d08-benchmark.ts.txt` uses `BunSqliteRepo` and its real migrations in an in-memory `bun:sqlite` database, with no live database. Bun 1.3.0 on macOS arm64. It creates 10,000 or 30,000 distinct storage buckets, all six billing dimensions across rows, 100 keys, fractional and null prices, explicit zero, full-identity price differences, request-only and token-only buckets, legacy empty incoming model, nullable upstream, and NUL-containing identity fields. There are about 30,000 request rows and 92,500 dimension rows in the larger fixture. Both paths use `[start,end)`. The scoped case filters one key using `json_each(?)` in SQL and the existing repo `keyIds` path in JS.

SQL groups dimensions by `(key_id,incoming_model,model,client,hour,dimension)` and requests separately by display identity. For fallback, a CASE-gated correlated lookup uses the full-identity unique index, with `COALESCE` preserving explicit zero. The `sql-once` variant materializes resolved price once per dimension row before grouping so the unpriced-token counter does not repeat the correlated lookup. It also keeps unresolved prices observable as `unpriced_tokens`. A real endpoint would use fixed axis enums, bounded time buckets, paged categorical breakdowns, and a separate full-scope total; those route/response pieces were not built here.

Each path ran in three independent processes per workload, with seven timed calls per process (first discarded). The table gives the range of the three within-process median latencies. Peak RSS is the range of `/usr/bin/time -l` maximum resident set size, inclusive of synthetic fixture setup and Bun runtime; it is not isolated query allocation. Modes were interleaved for the first two variants. `sql-once` was measured afterward, so cross-run drift remains possible.

| Workload | Path | Median latency range | Peak RSS range |
| --- | --- | ---: | ---: |
| 10k buckets, all keys | JS current | 26.84–27.95 ms | 108.4–112.5 MiB |
| 10k buckets, all keys | SQL correlated twice | 42.36–42.97 ms | 86.0–86.8 MiB |
| 10k buckets, all keys | SQL resolve once | 44.19–44.89 ms | 88.9–92.1 MiB |
| 30k buckets, all keys | JS current | 90.06–91.08 ms | 195.6–198.3 MiB |
| 30k buckets, all keys | SQL correlated twice | 174.94–204.52 ms | 129.9–131.5 MiB |
| 30k buckets, all keys | SQL resolve once | 137.84–138.32 ms | 137.2–138.3 MiB |
| 30k buckets, one key | JS current | 1.19–1.32 ms | 112.0–113.6 MiB |
| 30k buckets, one key | SQL correlated twice | 1.42–1.53 ms | 111.8–112.6 MiB |
| 30k buckets, one key | SQL resolve once | 1.46–1.49 ms | 110.1–112.0 MiB |

The 30k full-scope comparison materialized **122,519 source rows / 22,755,506 JSON-estimated bytes** on the current path versus **5,973 aggregate rows / 996,213 JSON-estimated bytes** with SQL, a 95.6% reduction by bytes. The one-key comparison was 1,226 / 222,866 versus 63 / 10,246. JSON byte counts estimate the SQLite-to-JS materialization payload; they are neither network response bytes nor measured D1 transfer bytes. The SQL results still need to be shaped into the endpoint response.

Full-scope and one-key SQL output matched the current display rows exactly for identity, request counts, and positive token counts. Every per-row cost was within `max(1e-12, abs(currentCost)*1e-10)`; the greatest observed absolute difference was `5.21e-18` full-scope and `1.74e-18` one-key. The fixture's SQL unpriced-token counter was 2,600,688 full-scope, verifying that null price is still distinguishable from priced zero. This is a fixture parity check, not a historical-data proof. An explicit empty-key probe returned zero SQL rows while existing `repo.usage.query({keyIds: []})` returned all scoped-time rows, confirming the helper hazard.

## Decision and next gate

The SQL design is implementable with the existing schema and preserves the tested historical fallback and fractional REAL prices. Materialization and peak RSS improve substantially for a wide all-key range, but the best safe SQL variant was about 1.5× slower at 30k buckets and the narrow-key case gained negligible memory. No endpoint/auth/UI code, Worker/D1 execution, date/bucket validation, pagination, or end-to-end response measurement was performed. The current production path should remain. If memory pressure or D1 row-transfer cost makes D08 a priority, build it as a separate bounded overview, keep detail available, and require real-SQL semantic fixtures for every dimension and owner scope plus Workers/D1 and dashboard workload measurements before adoption.

### Empty key list reachability audit

The empty-list widening demonstrated above is a **latent repository helper hazard, not a proven exposure through the current production route**. The complete production `repo.usage.query` call sites found under `vnext/` are the token-usage route and monthly quota check. The quota check passes a single authenticated `keyId` (`data-plane/observability/quota.ts:52`). In `control-plane/token-usage/routes.ts:142-146`, shared view derives owned IDs and returns `[]` before querying when none exist. In `routes.ts:171-180`, the session-user branch likewise returns `[]` before constructing `keyIds` from owned/assigned keys. API-key callers always pass their authenticated `keyId` (`routes.ts:165-170`), including when a session also exists. Admins intentionally query all keys or one requested key (`routes.ts:162-164`). Thus no production route branch identified passes `keyIds: []` to the generic helper; no synthetic route test was needed to classify reachability. The direct repository probe still establishes that a future caller without the early guard could widen scope because `buildKeyIdRangeQuery` only filters lists with `length > 0` (`repo/shared/repos.ts:304-320`). A new overview method should encode empty-list behavior at the repository boundary.

Copy `d08-benchmark.ts.txt` to a temporary `.ts` file and update its source import paths, then run from the worktree root (the commands below show the original scratch location):

```sh
bun .superpowers/sdd/2026-09-29-reference-adoption-follow-up/task-D08-benchmark.ts compare all 30000
bun .superpowers/sdd/2026-09-29-reference-adoption-follow-up/task-D08-benchmark.ts compare-once one-key 30000
```

The raw repeated-run summaries are `d08-benchmark-results.json` and `d08-benchmark-once-results.json` in this directory. No production files, dependencies, live databases, commits, or deployments were changed by this evaluation.
