# Ordinary hot-path optimization — local qualification

The routing and capture changes preserve the declared contracts, but this experiment does **not** demonstrate an overall speed or CPU improvement. The optimized candidate still has higher ordinary latency and sampled non-idle time than the deployed-source baseline. SSE settled heap is lower; this is not a peak-memory result. The changes are suitable for local vNext integration, while performance and rollback release gates remain open. No push or deployment occurred.

## What changed and why

| Boundary | Change | Contract retained |
| --- | --- | --- |
| Routing preparation | Read referenced proxy rows eagerly, but compile the request-only fallback resolver on first use. Direct-only preflight needs neither a proxy read nor a reference Set. | Repository failure remains outside contribution catches and before pin/colo filtering; visibility is unchanged. |
| Selected execution | Construct a single-upstream factory directly from the accepted catalog observation. Remove the one-entry repository adapter, fallback lookup Map, reference Set, array copy and extra async wrapper. | Exact accepted credentials/proxies and authoritative backoff owner; fresh observer-bound fetcher for each invocation. |
| Final response headers | Construct the client Response once from source headers, then stamp its private headers. | Original response and capture-time headers remain isolated across all finalization branches. |
| Diagnostic headers | Traverse native Headers synchronously through the native prototype operation; keep generic iterable fallback and one sanitizer. | Allowlist, order, omission counters and budgets remain unchanged. Native fields are authoritative for Headers subclasses, even if traversal methods are overridden. |
| Response prefixes | Stop attempting capture once the response prefix or shared body budget is exhausted. | Every demanded byte is still counted and forwarded; EOF, cancellation, read error, partial-copy accounting and settlement remain distinct. |

The resulting phases are explicit: configuration availability, request-only compilation, accepted execution, passive bounded observation and terminal persistence. Parsing stays framework-pure in dial; repository and runtime orchestration stay in gateway. No new cache lifetime, wire format, configuration option, migration or cross-request execution state was introduced. Owned frame projection and complete sidecars remain required.

The reference project's eager proxy setup offered no direct optimization for this path. Its URI-bearing errors and colo-filtered validation were not adopted because they would change privacy and failure semantics.

## Identity and verification

- Product commits: `cba1d5407d5f7a8f1dd527692f269c4f2ad14ac5` (capture) and `f96b0337613e5decbb7a084cd7763349925a2f4d` (dial), following design commit `788f71a052ca273822f592fad2d181325652034e`.
- A: clean deployed-source `e660fb4dfcf1734d10f89e52e2d739b2985c634b`, tag `vnext-deployed-20260928-233856`.
- B: frozen HEAD `f96b0337613e5decbb7a084cd7763349925a2f4d`, plus the preserved 14-file collaboration overlay and actual generated assets. Its product inventory has 1,573 files, including the new dial test. A commit alone does not reconstruct this overlay or the installed dependency closure.
- Experiment: `e6cc8858-0c25-4c33-8726-e715223b5744`. Freeze 01 manifest SHA-256: `3eb87949abd347242c49f5dff9d3cc5434bd44a58090fc6a81717cc0afa50ff9`.
- Unchanged harness: Bun 1.3.0, Miniflare 4.20260601.0, workerd 1.20260601.1, Wrangler 4.97.0; compatibility date 2025-06-01. All 29 historical tool/spec identities remain unchanged. Existing exact-lock resolution and its two TLS dependency exceptions remain part of reconstruction, as documented in the [previous comparison](../2026-10-02-workerd-deployed-comparison/results.md).
- Each implementation passed independent specification and quality review. Focused gates: dial 77 tests and gateway/dial typechecks; capture 159 tests and gateway typecheck.
- Fresh `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` exited 0: 5,955 pass, one skipped, zero failures, 237,692 expectations across 560 files. Purity, all package typechecks, UI/setup build and Wrangler dry-run passed. ESLint reported zero errors and 38 warnings. Assets were frozen after CI.
- Separate canary: four requests / ten objects, exact Inspector targets and completed cleanup. Formal: 716 requests / 1,790 objects across the five declared units. One freeze, one canary and one formal attempt were used; no favorable-number retry or sample pooling occurred.
- Independent metric recomputation and physical review passed: 39,524 checks, zero problems, all 9,537 frozen input files matched, and all 2,825 original experiment evidence files remained unchanged. The auditor opened only copied SQLite/WAL/SHM and decoded every physical object. All eight saved build/collection PIDs were absent afterward.

The [machine-readable results](results.json) retain exact values, block medians, heap fields, baseline failure cells and evidence hashes. Raw evidence is retained at `.superpowers/sdd/2026-10-03-ordinary-hot-path/` in the repair worktree. It includes task reports/reviews, CI logs, freeze/canary/formal artifacts, independent analysis, physical review and `local-integration-receipt.json` for final branch/preservation state. The plan and prior evidence are retained.

One intermediate dial test log was overwritten by its implementer during fixture correction. The remaining tool-transcript excerpt is explicitly labeled as an excerpt, not a recovered full raw log. The complete final focused log and fresh CI are preserved. The failed fixture incorrectly assumed a retained catalog must immediately use the newest database epoch; the final test forces a fresh accepted observation while retaining pinned configuration, without changing production retention semantics.

## Measured ordinary workload

The workload remains a fixed 64 KiB request with a short synthetic response, three eligible providers, dump persistence enabled and Responses history retention disabled. Ordinary timings use 40 samples per mode/variant in AB/BA/AB/BA blocks, without Inspector. Diagnostic windows separately run 40 requests per mode, B then A, including background settlement. Existing host services remain running; host scheduling is not isolated.

| Metric | Deployed A | Optimized B | B versus A |
| --- | ---: | ---: | ---: |
| JSON EOF p50, ms | 12.778 | 14.609 | +14.33% |
| JSON EOF p95, ms | 18.791 | 21.987 | +17.01% |
| SSE EOF p50, ms | 68.334 | 71.782 | +5.05% |
| SSE EOF p95, ms | 84.974 | 91.865 | +8.11% |
| SSE first semantic p50, ms | 44.068 | 50.436 | +14.45% |
| SSE first semantic p95, ms | 63.396 | 73.157 | +15.40% |
| JSON sampled non-idle, ms/request | 12.484 | 13.363 | +7.04% |
| SSE sampled non-idle, ms/request | 69.786 | 75.637 | +8.38% |
| JSON settled used heap, MiB | 27.436 | 27.850 | +1.51% |
| SSE settled used heap, MiB | 32.026 | 26.956 | -15.83% |

JSON EOF block deltas are +0.036, +4.073, +0.066 and +5.532 ms. SSE EOF changes sign across blocks, but SSE first-semantic medians are higher in all four B blocks (+3.603, +3.421, +4.548 and +0.251 ms). These observations support continued analysis before the first SSE event; they do not establish a stable production percentage or a causal per-feature cost.

CPU uses sparse weighted V8 samples, not billed or process CPU. JSON has only 72/83 samples and SSE 295/380 for A/B. Sample weights do not always span the entire profile window. Heap is settled `usedSize` without forced GC; initial JSON heaps differ (21.915/25.882 MiB), and SSE begins at the preceding JSON settled value. It is neither peak memory, RSS, leak proof nor Cloudflare memory-limit qualification.

The previous experiment's B observed JSON/SSE EOF p50 of 14.498/71.002 ms; this B observes 14.609/71.782 ms. Previous B sampled non-idle values were 17.309/71.335 ms/request; this run observes 13.363/75.637. These are **separate-run descriptions**, not paired estimates of this increment's effect. A also changes between runs. A smaller current JSON sampled gap cannot be attributed solely to dial optimization.

## Why the performance gap remains open

Source review confirms fewer preparation objects and header copies, but much of this increment addresses paths the ordinary fixture does not stress: direct-only routing has no real proxy URI to parse, and a short response does not saturate its capture prefix. Selected-factory and header work can affect this fixture, but their individual cost is not isolated by the experiment.

The candidate still performs required owned projection, bounded upstream observation, strict terminal validation and additional sidecar persistence. Removing a few setup operations does not remove those costs. Sparse profile leaves, especially native stream and binding functions, cannot safely assign the entire difference to one subsystem. The next analysis must connect producer/consumer stages and object ownership to actual pre-first-event work before changing those boundaries.

Five representative functions and their ancestors were checked directly against the frozen bundle. The prominent native `forEach` samples belong to the initial owned dump-header snapshot, not this increment's collector traversal. Other observed contexts include configuration-list `structuredClone`, affinity cloning during input analysis and materialization, response/upstream gzip preparation, and demand-SSE serialization. These are concrete source-analysis leads, not feature cost estimates. `formal-01-profile-notes.md` in the raw root records the anchors and unchanged hashes of all 11 inspected inputs.

## Correctness and persistence

| Oracle, 126 matrix cells per variant | A failures | B failures | Regressions | Improvements |
| --- | ---: | ---: | ---: | ---: |
| Client wire semantics | 19 | 0 | 0 | 19 |
| Persisted response fidelity | 4 | 0 | 0 | 4 |

All ordinary observations also pass both checks. The extra zero-B-failure gate preserves every fixture success of the pre-optimization candidate; checking only A-pass/B-fail would be insufficient. The four owned-frame capture fixes remain intact. These are preserved earlier fixes, not four new fixes made by this increment.

Capture retains its explicit domains: JSON producer semantics, SSE event values/DONE and the reviewed renderer-appended error boundary, or exact bytes for byte descriptors. The inherited B56 policy-refusal case remains HTTP 200 with failed policy envelope while dump metadata is 502; no universal status/byte equivalence is claimed.

| Formal storage, 358 requests each | A | B |
| --- | ---: | ---: |
| Owned objects | 716 | 1,074 |
| Request compressed bytes | 97,657 | 97,759 |
| Response compressed bytes | 139,848 | 139,966 |
| Upstream compressed bytes | 0 | 511,962 |
| Total compressed bytes | 237,505 | 749,687 |

Every B request retains its sidecar. The extra 358 objects are intentional. Synthetic repeated input compresses unusually well, so these bytes are not a production storage forecast. All background work settled; snapshots/items remain empty. Native response capture has 337 EOF and 21 cancelled attempts under the existing terminal contract, while every fixture dispatch completes exactly once. Cancellation of capture does not imply cancelled fixture transport.

## Next priorities

1. Trace affinity input analysis through target materialization, then dump-header snapshots through owned projection and gzip preparation. Reduce repeated traversal and representation changes within the same owner while keeping configuration isolation, immutable capture, demand-driven delivery and terminal guarantees. The observed affinity-copy and dump-preparation paths provide concrete starting points. Complete the next coherent optimization batch before another aggregate comparison; this run does not justify declaring the performance issue fixed.
2. Qualify large requests, concurrent requests and slow consumers under the resource policies. Exercise actual prefix/shared-budget saturation, queue pressure and hosted-search paths. Current settled-heap observations cannot close the original memory-limit gap.
3. Complete [catalog/affinity rollback compatibility](../2026-10-01-resource-capacity-policy/rollback-readiness.md), including a named compatible rollback artifact, old/new code switching on migrated data and backup/restore evidence. The deployed tag alone is insufficient.

Local integration retains useful preparation boundaries and verified contracts. CFW deployment remains deferred until the resource and rollback gaps are closed.
