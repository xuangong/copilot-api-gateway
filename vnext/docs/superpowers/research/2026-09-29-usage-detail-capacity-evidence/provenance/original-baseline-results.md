# D08 actual baseline whole-load observations

Accepted product HEAD at host startup: `8f39d0d6dacac78c77ecf2704631fbd3cf7fa734`. Only existing Usage APIs were called. D10B source edits were in progress in disjoint setup/UI files; no setup build/test runtime overlapped these timed HTTP loads, except a permitted lightweight static-check/build window near the high-D1 run. These are single-run diagnostics, not repeated benchmarks, production latency, React paint or projection results.

Same fixture stream/hash in actual SQLite and workerd/D1:

- realistic: `f5aaf1b53700a534b40f1b559fd506da212a0acad06b83abadcaa22dee7d795c`; 9,539 usage rows / 4,822 request rows.
- high: `46986861e0cca8e52657b3f1e8d04e8a98e2370168b007d0150101e6da827978`; 334,331 usage rows / 167,218 request rows; 1,001 assigned-only keys, 418 incoming categories, 410 routed/client categories, 404 wide mapping pairs, 402 assignments on one key. Counts include deliberate edge fixtures.

Seed time excluded. Actual baseline dashboard API helpers fetched all current main/participants/strip HTTP families. No browser render measurement, encoded/transfer size or projection adapter was executed. Native D1 first() hides rows-read metadata: complete rows-read remains null; the known subtotal is not total billed cost. Auth and metadata statements are included in SQL counts; per-phase classification remains pending.

| Runtime | Fixture | Principal-view | Complete | HTTP | SQL | Decoded bytes | Elapsed ms | Known D1 rows-read subtotal |
|---|---|---|---|---:|---:|---:|---:|---:|
| sqlite | realistic | admin-today | True | 2 | 39 | 23750 | 8.77 | None |
| sqlite | realistic | admin-28d | True | 3 | 50 | 1536438 | 49.31 | None |
| sqlite | realistic | viewer-today | True | 2 | 44 | 15537 | 12.10 | None |
| sqlite | realistic | viewer-28d | True | 3 | 59 | 1225057 | 31.65 | None |
| sqlite | high | admin-today | True | 2 | 2224 | 518849 | 26.15 | None |
| sqlite | high | admin-28d | True | 3 | 2632 | 53060504 | 1234.52 | None |
| sqlite | high | viewer-today | True | 2 | 3818 | 387576 | 36.20 | None |
| sqlite | high | viewer-28d | True | 3 | 4826 | 43032207 | 962.82 | None |
| workerd | realistic | admin-today | True | 2 | 39 | 23750 | 16.70 | 328 |
| workerd | realistic | admin-28d | True | 3 | 50 | 1536438 | 102.50 | 17703 |
| workerd | realistic | viewer-today | True | 2 | 44 | 15537 | 17.92 | 14446 |
| workerd | realistic | viewer-28d | True | 3 | 59 | 1225057 | 78.33 | 45764 |
| workerd | high | admin-today | True | 2 | 2224 | 518849 | 427.35 | 10848 |
| workerd | high | admin-28d | True | 3 | 2632 | 53060504 | 3294.99 | 629825 |
| workerd | high | viewer-today | False | 2 | 3817 | 85107 | 808.10 | 5219 |
| workerd | high | viewer-28d | False | 3 | 4824 | 85128 | 1159.23 | 6627 |

High assigned-only workerd calls failed with actual `D1_ERROR: too many SQL variables at offset 331: SQLITE_ERROR`; `/api/token-usage/participants` completed, main/strip detail failed. This is a real capacity failure, not a successful fast result. High admin succeeded with 53,060,504 decoded bytes and 2,632 SQL statements for 28d. Ordinary high SQLite succeeded with 4,826 SQL statements. Single-run timing is diagnostic only.

## Retained local artifacts

- `d08-acceptance/runs/*-baseline/*.{config,result}.json` and `runs/source-counts.json`. All credentials are explicitly synthetic.
- SQLite source/SQL/EXPLAIN directories: `/var/folders/v7/g66mk9zs7cgbrqg7gzgycqlm0000gn/T/d08-acceptance-XRJbLE` (realistic), `.../d08-acceptance-MJbkQa` (high).
- D1 source/SQL/EXPLAIN directories: `/var/folders/v7/g66mk9zs7cgbrqg7gzgycqlm0000gn/T/d08-workerd-9YNGSQ` (realistic), `.../d08-workerd-ajqLSF` (high).
- Host logs: `/tmp/vnext-d08-workerd-{realistic,high}-host.log`, `/tmp/vnext-d08-sqlite-high-host.log`.
- Every owned server has been stopped after evidence capture. No production DB was accessed.

## Consequence for the next D08 slice

Source review must first locate the legacy per-key placeholder expansion and N+1 enrichment, compare the existing overview's bounded `json_each` scope/bulk metadata approach, and propose a small compatibility repair. Retain these original measurements. Any repaired baseline is labelled separately before comparison with new projections. Do not migrate UsageTab solely on bounded-page arithmetic or this baseline; full projection/consumer authorization, accounting, paging, browser and same-fixture whole-load gates remain pending.
