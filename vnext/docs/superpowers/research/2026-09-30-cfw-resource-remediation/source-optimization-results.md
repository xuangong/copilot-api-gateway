# Source optimization batch: final result

Date: 2026-09-30. The agreed optimization list is implemented and independently reviewed. The complete candidate passed functional CI and the declared cloud workloads, but **ordinary-request resource acceptance failed**. Keep the changes on `fix/cfw-resource-rollback`; do not merge into vNext or deploy this candidate on the strength of these results. Production, rollback tags and original backups were not changed.

This report quantifies the complete source batch once. It does not assign benefits to individual edits or pool the earlier Bun failure with Node results. Machine-readable paired observations, gates and 84 input hashes are in [source-optimization-node-metrics.json](./source-optimization-node-metrics.json). That report has no missing/unqualified inputs and no integrity issues; its outcome is `INVESTIGATION_REQUIRED`, not resource acceptance.

## Completed implementation and verification

All entries in the [source optimization list](./source-optimization-priorities.md) and implementation Tasks 1–4 in the [batch plan](../../plans/2026-09-30-cfw-source-optimization-batch.md) are complete:

- Separate affinity preparation from shared execution state, narrow deferred captures, and remove unused HTTP history retention.
- Normalize trusted internal upstream envelopes once; consume compression inputs and release upload buffers by stage, retaining borrowed-input snapshots and publication fencing.
- Make SSE demand-driven and supply canonical dump completion without redundant response collection, preserving cancellation, terminal-tail validation and prompt HTTP completion.
- Reduce per-frame interruption and byte-count allocations, index output reconciliation, and incorporate related header/helper allocation fixes.

These changes improve source-level ownership and buffering boundaries. They do not establish lower whole-service CPU, memory or latency. Some target large inputs, slow clients or many-frame/item streams rather than the small ordinary fixture.

Source-only commit: `cdd2eb5ceb6ae991b1c5ec61d459f4cf22e0b03b` (`perf(vnext): reduce request and streaming resource retention`), 58 source/test paths. It excludes the pre-existing collaboration overlay. Frozen CI03 recorded 5,384 passed, 2 skipped, 0 failed and 228,953 assertions; purity, typechecks, lint, UI build and Worker dry-run passed. All 2,329 frozen source hashes were rechecked unchanged. The 35 existing lint warnings and same-lock APFS dependency reuse remain explicit boundaries; this was not a clean installation. CI01's fixture type failure and CI02's ownership assertion failure remain archived alongside their fixes.

The tested artifact is the complete frozen workspace **including the preserved overlay**, with Git parent `5dd55e0bcb1d35567336d19ed919efb82b85789c`. The optimization-only commit is not the complete tested artifact. Twelve current overlay files remain byte-identical to their original archives; the overlapping Responses attempt retains the reviewed combined bytes, while its commit contains the separate optimization-only extraction.

## Declared cloud workloads

These are isolated CFW Workers with a synthetic upstream, not production traffic or paid-provider/native-client acceptance. Both variants retained the original feature/settings and numeric dump/Responses retention 0/0. Dump retention zero enables the writer; it is not a capture-disabled control or an assertion of unlimited retention.

| Workload | Total requests across A and B | Result | Scope |
| --- | ---: | --- | --- |
| Node canary | 16 | 16 successful | Correctness and accounting preflight |
| Ordinary Responses | 4,000 | 4,000 successful | 64 KiB, JSON/SSE, five AB/BA blocks, 200 requests per variant/block/mode, 5 arrivals/sec, cap 16 |
| Ascending sizes | 80 | 80 successful | 64 KiB, 1 MiB, 8 MiB, 32 MiB, JSON then SSE, five blocks |
| Reversed history | 20 | 20 successful | 32 MiB, SSE then JSON, five blocks |

All four runs have complete semantic/transport results, exactly one fixture dispatch per logical request, complete task retirement, zero drops and no qualification post-errors. Maximum active tasks were 2/7/1/1 respectively. Before/after source, version, settings and retention checks passed. Large/history cells contain one request each; their success does not establish an ordinary latency distribution, per-request memory maximum or immunity to OOM. The earlier large-body OOM repair is a separate checkpoint and cannot be attributed to this batch.

Initial and delayed collections each contain all required CPU/memory measures and success-only runtime observations. All 30 paired raw windows across ordinary, large and history runs are byte-identical between collections. Collection start times (UTC) were:

| Run | Initial | Delayed |
| --- | --- | --- |
| `full-node-01` | 06:57:29.340020 | 07:00:36.582481 |
| `large-node-01` | 07:02:04.909405 | 07:05:21.607833 |
| `history-node-01` | 07:07:43.679014 | 07:08:42.392345 |

## Ordinary-request resource result

The original paired thresholds remain unchanged: CPU p50/p95 growth above 10%; memory p99 growth above `max(10%, 2 MiB)`; client p95 growth above both 10% and 20 ms. A favorable median does not override a failing pair.

| Measure | Median paired change | Pairs above threshold | Decision |
| --- | ---: | ---: | --- |
| Worker CPU p50 | +25.25% (+2.405 ms) | 5/5 | Fails |
| Worker CPU p95 | +26.99% (+3.764 ms) | 5/5 | Fails |
| Shared-isolate memory p99 | +3.92% (+2.27 MiB) | 2/5 | Fails; worst pair +54.40% (+24.99 MiB) |
| JSON client p95 | +32.94% (+60.23 ms) | 4/5 | Fails |
| SSE client p95 | -2.91% (-7.06 ms) | 2/5 | Fails despite the favorable median |

These are medians of paired block statistics, not pooled request or platform quantiles. Ordinary client p50 was broadly unchanged (median paired JSON -0.40%, SSE -0.84%); this does not cancel the tail-latency or resource failures. No statistical-significance claim is made.

All five ordinary platform pairs are retained below. CPU is in milliseconds; memory is in bytes. Each platform window mixes JSON and SSE.

| Block | A CPU p50 | B CPU p50 | A CPU p95 | B CPU p95 | A memory p99 | B memory p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 9.525 | 11.930 | 13.849 | 17.895 | 60,777,064 | 63,158,264 |
| 1 | 10.051 | 11.921 | 14.580 | 18.344 | 48,175,596 | 74,380,800 |
| 2 | 9.262 | 12.164 | 13.199 | 16.762 | 61,631,720 | 61,907,964 |
| 3 | 9.573 | 11.828 | 12.853 | 17.665 | 59,932,876 | 69,840,750 |
| 4 | 9.329 | 12.003 | 14.247 | 17.770 | 63,551,170 | 62,707,548 |

The full-run preflight receipts place A's D1 primary at NRT and B's at KIX. This is a current placement difference, superseding the earlier diagnostic's KIX observation for its own run. Client latency cannot be attributed entirely to source changes. CPU is a platform sampled quantile; memory is a shared-isolate quantile, not a per-request peak. Adaptive request sums are neither exact offers nor effective sample sizes. The original A upload also lacks a launch-time source inventory; checking its unchanged version before/after does not close that provenance gap.

## Failures and client-runtime boundary

`source-opt-v1-01` stopped at the initial read-only API GET with HTTP 401 before deployment. Its evidence remains unchanged and no restore applies. The existing Wrangler authentication was refreshed; deployment and all subsequent runs used a separately recorded experiment, `source-opt-v1-02`.

The original Bun `full-01` failed closed after 600 started/settled tasks: 597 journaled successes and three candidate JSON rejections before request ID, EOF, journal or return markers. Only error category `Error` was retained, without a stack/cause. All started tasks retired with zero drops. The duplicate-ID flag came from three null IDs; the fixture recorded 597 unique IDs, each dispatched once. This is incomplete adverse evidence, not a proven gateway failure or a proven Bun/JSC cause. See [the preserved failure record](./source-optimization-driver-failure.json).

The previously qualified four-file driver was then run under pinned Node 26 through a separately reviewed runtime-only adapter. Source, workload cells, limits, gates and original driver/package files were unchanged. Node and Bun use different client HTTP/scheduling implementations, so their timing observations remain separate. No automatic request retry was introduced.

## Artifact and operational closure

| Identity | Value |
| --- | --- |
| Frozen source manifest SHA-256 | `0d909fba9d74f67d09d8fdb35ddcb528d2e1dd35f45050d433231d79e368bb01` |
| Measurement package manifest SHA-256 | `15bd298a5d5e38db98af14aa11414e953fc0e737a7652a486feb13d70f3ad224` |
| A baseline version | `c8217d3e-dfb0-48a6-941b-c7bb173b83b7` |
| D candidate version | `be4a79e2-cc81-4b6a-8c65-5f63834c108c` |
| D candidate deployment | `e7503cd0-c9c7-4936-897d-be86cdbeaec8` |
| Restored D ordinary version | `bd4dd2c5-b806-40c8-b869-a34372919cdf` |
| Restoration deployment | `8605bafa-ece6-4862-9f11-9cc8a14b7455` |

After all inference workloads ended, D was restored at `2026-09-30T07:07:58.827016+00:00`. Readback confirmed 100% on the archived ordinary version, matching non-versioned settings and retention 0/0. Only the isolated measurement Worker was restored. No merge into vNext, push, production deployment, production data change or backup/tag rewrite occurred.

Private evidence root: `/Users/zhangxian/.local/share/copilot-gateway-backups/cfw-p0-20260930/ordinary-source-v1/source-opt-v1-02`. Important records are `runs/{canary,full,large,history}-node-01`, `runtime-adapters/*/result.json`, `restore-completed.json`, and `restore-records/restore-01/after.json`. SHA-256:

- Final metrics JSON: `29e8efad818a38e326f6a8037c02da504f3834b27fdc3c7f419bdde3a871d78c`.
- Restore completion: `f34337c77703736f004251249d55a4198c76d897617b85b7d0560c7cc5e461c3`.
- Restore readback: `97386c444845418883bd0892c03aa483cbc761660f8df2ea605b7f9d327054bf`.
- Runtime adapter: `370832a4568b19cb5fba43f6ff575cdd13658071c0f2f1294ab3cb2e9480eda6`.
- Node metrics summarizer: `1ce4c51733fc4335104df1a74692f7f954774ed9bbcbfae86d1673b647261be9`.

## Remaining priorities

1. Locate the ordinary Responses work responsible for the remaining approximately 2.4 ms paired median CPU p50 increase. Trace the required foreground and completion/capture paths against the deployed baseline before choosing another bounded implementation batch. Do not repeat completed list items or claim that large/slow-stream improvements explain this gap.
2. Reduce shared-isolate memory variability without moving CPU work into more queues, compression parallelism or speculative caches. Account for placement differences before attributing client latency. Any further diagnostics should answer a concrete source hypothesis; do not start another broad load campaign as routine verification.
3. Finish catalog legacy-writer invalidation and authenticated affinity rollback compatibility, then qualify the combined artifact under enabled-feature, fault/cancellation/protocol and mixed-soak gates. Existing immutable rollback tags cannot be assumed to understand a newly introduced carrier format.

Task 5's final quantification and documentation are complete. The parent resource acceptance, rollback compatibility and integration/release gates remain open.
