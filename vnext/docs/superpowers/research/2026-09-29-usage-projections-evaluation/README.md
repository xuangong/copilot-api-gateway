# D08 C2 projection candidate: evaluated, not adopted

Date: 2026-09-29. Accepted product HEAD: `eef2bc02edaac39415a23f6070f6956e51a27bfc`. This report closes the proposed C2 projection contract after three correction rounds. The candidate passed the completed same-fixture correctness oracle, but its full request-plan cost failed adoption. The 11 candidate files were restored to accepted HEAD; [the exact rejected patch](rejected-c2.patch) is evidence, not product code. The accepted overview API, Keys quota consumer, legacy detail filter and capacity repair remain in place. UsageTab still uses legacy detail; C3-C6 were not implemented.

## Whole-load result and decision

The root-owned `projection-cost-QDy7cGIq` run exited 0. It compared 32 proposed HTTP plans: SQLite and local workerd/D1, realistic and high-cardinality fixtures, admin and assigned-only viewer, today and 28 days, with 168-hour and 24-hour series chunks. All 32 timed cases and 32 follow-on oracles completed. The oracles recorded **2,861,372 checks and zero mismatches** against the accepted legacy-detail projection, within the oracle's documented metadata boundary. This verifies the captured candidate behavior; it does not make its cost acceptable.

| High fixture, 28 days, 168-hour chunks | Legacy elapsed | C2 elapsed | HTTP legacy → C2 | SQL legacy → C2 | Decoded bytes legacy → C2 |
| --- | ---: | ---: | ---: | ---: | ---: |
| SQLite admin | 986 ms | 7,237 ms | 3 → 76 | 17 → 366 | 53.06 MB → 4.60 MB |
| SQLite assigned-only viewer | 1,223 ms | 9,065 ms | 3 → 86 | 22 → 440 | 43.03 MB → 8.26 MB |
| workerd/D1 admin | 2,655 ms | 7,174 ms | 3 → 76 | 17 → 366 | 53.06 MB → 4.60 MB |
| workerd/D1 assigned-only viewer | 2,700 ms | 9,272 ms | 3 → 86 | 22 → 440 | 43.03 MB → 8.26 MB |

The candidate was slower in 31 of 32 recorded comparisons. The one faster case was workerd/realistic/admin-today with 24-hour chunks (27.8 ms versus 30.0 ms), which does not alter the high-cardinality gate. The 24-hour high viewer worsened to 17,390 ms on SQLite and 16,793 ms on workerd/D1. The workerd/D1 24-hour high-viewer **known rows-read subtotal** was 203,431,816 versus 1,655,037 for legacy; it is not a complete rows-read total because some D1 calls expose no value. The full 32-case measurements and per-case oracle counts are in [metrics.json](metrics.json). Decoded response bytes are not encoded transfer bytes. This is a proposed HTTP-plan load, not an actual UsageTab/browser load.

The separate captured-SQL probe retained in scratch compared 32 statements with original, narrow-presence, and forced-hour-index variants: all 96 produced exact full JSON equality. Narrow presence helped some catalog and existence statements, but distribution and time accounting remained material costs. The probe always ran original first; cold-cache/order effects make isolated timing ratios unsuitable as a stable whole-load prediction. The forced use of an existing hour index was diagnostic only, not an authorized product hint, and may regress sparse authorized scopes. No fourth optimization round or consumer switch is authorized by this result.

## Provenance and reproduction inputs

Let `W` be `.worktrees/reference-adoption/.superpowers/sdd/2026-09-29-reference-adoption-follow-up` under the repository root. Scratch artifacts are retained at these local paths:

- `W/task-D08-C2-fix3-r2-frozen/` and `W/task-D08-C2-fix3-r2-manifest.json`: byte-identical 11-file candidate snapshot and SHA-256 manifest. Manifest SHA-256: `633e6e94a0e9cfbffadd1b9062d2f63877ebb88292a40f43faf7c9f68b588175`.
- `W/task-D08-C2-fix3-r2-rejected.patch` and `W/task-D08-C2-rejected-preservation.json`: fresh complete diff and pre-restoration proof. The patch here is byte-identical; SHA-256: `6c8fdf3069a9d75e722578b6831e81cbeeef7d64f1ea6e1859ac4c3d60eb28b3`.
- `W/d08-projections-acceptance/runs/projection-cost-QDy7cGIq/summary.json`: all 32 timed rows and source paths; SHA-256: `413754825a9e0999d94654ceb4edfe965474b78a6b1410440e6318fae57267a9`. The same run contains per-case result/oracle files, before/after candidate, product and baseline hash manifests, fixture manifests, `harness.sha256`, `oracle-harness.before.sha256`, and exit status. Its baseline is `W/d08-acceptance/runs/repaired-detail-qumZYkMT/`.
- `W/d08-presence-probe/probe.ts` and `results.json`: isolated statement experiment; results SHA-256: `a78210cd0ccbba781564adbd1a7ebe0bdc23dda45d3818f96a1da9a35c287a09`.

The root-owned runner is `W/d08-projections-acceptance/run-projection-cost.sh` (SHA-256 `f98f3a290639b86412ab3a17ae8517c43e3bce1b781a07dd0150891f0436c3dd`), with `whole-load.ts` (`d6a44c6367268569c1b33bd7f0c1f6ca1f4cf994606d2dce46b48ba30ed92e99`), `verify-frozen-inputs.py` (`8f20f64c9fac89315f90955d5ed49ce86fb5d5d49741fdd59e54036a696e9d62`), oracle `W/d08-projections-oracle/oracle.ts` (`bf2076877371d93a00b15a4e5f5963f5dc83386154e2d79b258c93514782ab28`), and fixture generator `W/d08-acceptance/fixture.mjs` (`b1c3c578b88b4e2d217e6e39d0929b0045d9c9ac11c2383ee655e622244bb972`). The run's own `harness.sha256` records the remaining host adapters. Reproduction requires an isolated checkout at the exact accepted HEAD with the rejected patch applied, the repaired-detail baseline and fixture inputs, and root-owned runtime coordination. This closeout did not rerun hosts, SQL or tests.

The independent candidate review approved the scoped C2 behavior after fix3-r2, but that review and oracle do not override the whole-load cost decision. The legacy capacity repair remains the accepted practical path until a separately designed request/aggregation strategy demonstrates a viable full-load tradeoff.
