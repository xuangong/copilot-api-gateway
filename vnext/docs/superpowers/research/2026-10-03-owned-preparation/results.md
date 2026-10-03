# Owned preparation — local qualification

The private affinity copier and synchronous dump compression handoff preserve their contracts. This run does **not** establish an overall performance improvement or close the memory-limit issue. JSON latency and sampled non-idle time remain above deployed source. SSE median latency is close to deployed source, but its first-semantic p95 is higher. Settled heap is lower in this observation; peak memory remains unqualified. Local integration can retain these bounded implementation improvements, while CFW deployment remains deferred.

## Changes and architectural value

| Stage | Change | Required contract |
| --- | --- | --- |
| Affinity capture | Checked traversal records provenance only after completing the whole plain-container graph. | Runtime objects/accessors retain native fallback; partial capture is never trusted. |
| Candidate and attempt construction | A private bound copier skips repeated prototype/descriptor discovery. | Every consumer still receives independent containers; cycles, aliases, sparse arrays and safe property definitions remain intact. |
| Dump input preparation | gzip now prepares and hands off its source synchronously, returning an output-only promise reaction. | Borrowed bytes are snapshotted before return; transferred bytes avoid another Blob snapshot; strings still use Blob; synchronous failures become original-error rejections. |
| Empty-response finalization | Private persistence reuses the just-created frozen header pairs. | Public numeric/turn callers still receive defensive copies; first terminal, status, events, client headers and background settlement remain authoritative. |

The architecture now distinguishes checked capture, independent construction, compression input handoff and output settlement more explicitly. The trusted affinity helper is module-private, with no public trust flag or cross-request cache. Its snapshot stays inside analysis and never escapes through the returned facade. `{ ...body }` remains at the analysis boundary to preserve root getter and root self-reference behavior.

The reference checkout `1d7dcd923e260e425120cca0c7a240e93720af27` offers a useful separation of projection planning from construction. Its shallow Responses projection and candidate reuse do not provide this repository's mutation isolation, so those mechanics were not copied. The adopted principle is to avoid repeated discovery within one owner while preserving independent consumers.

There are no new dependencies, environment variables, configuration fields, wire formats, schemas or migrations. Complete upstream sidecars, immutable event capture, serial compression, demand, budgets, mandatory-versus-optional failure handling and terminal settlement are preserved. The gzip refactor does not prove that a previous V8 version retained async locals, or that input becomes collectible sooner: native streams may legitimately retain it until consumption.

## Artifact and verification

- Product commits: `644021afe9cd7155d4f74b7bd16ffe026b4d5462` for dump and `cb5ca3b17736dabc6f217c36d3961a40f111cfe5` for affinity, following design commit `174189ebf4d1cac2c687d3ea9050103e4a0be818`.
- Deployed-source A: clean `e660fb4dfcf1734d10f89e52e2d739b2985c634b`, tag `vnext-deployed-20260928-233856`. This is a local source comparison, not a fresh query of production deployment state.
- Frozen B: `cb5ca3b17736dabc6f217c36d3961a40f111cfe5`, plus the preserved 14-file collaboration overlay and post-CI generated assets. Its tracked/untracked product inventory contains 1,573 files. HEAD alone cannot reconstruct the overlay, assets and installed dependency closure.
- Experiment ID: `05f341af-02b0-4c30-8c5d-9958b29ac722`. Manifest SHA-256: `cab25076654be13791f6e0d166f7cd3468fe7627842964b089fec26c4abab442`.
- The existing harness is unchanged: 29 tool/spec identities match. Runtime is Bun 1.3.0, Miniflare 4.20260601.0, workerd 1.20260601.1, Wrangler 4.97.0; compatibility date 2025-06-01, `nodejs_compat`. Existing exact-lock resolution and its explicit TLS dependency exceptions remain documented in the [original comparison](../2026-10-02-workerd-deployed-comparison/results.md).
- Affinity focused verification: 16 tests; grouped affinity: 138 tests. The preserved before run has one expected failure observing eight repeated prototype checks; the after run observes none on subsequent plain copies. Compatibility cases passed before and after. This is mechanism evidence, not a performance measurement.
- Dump grouped verification: 169 tests across eight suites. New error/header cases also passed before implementation and are explicitly behavior-preservation checks. Shared gateway typecheck passed. Both tasks passed independent specification and quality review.
- Fresh `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local`: exit 0, **5,966 pass / 1 skip / 0 fail**, 237,774 expectations across 560 files. Framework purity, all package typechecks, UI/setup builds and Wrangler dry-run passed. Lint has zero errors and 38 warnings. CI ran at the frozen product HEAD; generated assets were frozen afterward.
- One freeze, one four-request canary and one 716-request formal run completed. No favorable-number retry or cross-attempt pooling occurred. Canary produced ten objects, attached to both exact Inspector targets, settled background work and exited before formal collection.
- Independent metric recomputation and physical audit passed: **39,524 checks / zero problems**, 9,537 frozen files matched, 716 formal requests and 1,790 owned objects. The auditor opened only copied SQLite/WAL/SHM, decoded every physical object and preserved all 2,825 original experiment evidence files. All eight saved build/collection PIDs and process groups were absent afterward.
- Before and after measurement, the prior three evidence directories matched their baseline: 7,973 files / 863,347,799 bytes, with no membership, size or SHA-256 changes. MAIN's 38 protected files, the repair worktree's 14 protected files and fixture PID 90455/start identity also remain preserved; final integration repeats the product/protected checks.

[Machine-readable results](results.json) contain exact values, block medians, all heap fields, baseline failure details and input hashes. Raw evidence is retained in `.superpowers/sdd/2026-10-03-owned-preparation/` in the repair worktree, including task reviews, CI, freeze/canary/formal data, independent analysis, physical audit and process checks. Final branch/protected-file state is recorded separately in `local-integration-receipt.json`; documentation-only commits after the frozen product HEAD do not change the measured product. No push, deployment, dependency installation, existing-service restart or cleanup is part of this delivery.

Post-merge checks match all 1,573 tracked/untracked product files in both worktrees to the tested source inventory. All 1,581 frozen candidate source inputs, including generated assets, still match in the repair worktree. MAIN has nine different ignored setup/dashboard generated assets; the Git fast-forward does not replace them, and this delivery leaves them untouched. Qualification belongs to the frozen repair artifact. Any later release must rebuild and identify its generated assets rather than treating MAIN's Git HEAD alone as that tested artifact.

## Ordinary workload results

The fixture is a fixed 64 KiB request with a short synthetic response, three eligible providers, dump persistence enabled and Responses history retention disabled. Latency has 40 samples per mode/variant in four AB/BA/AB/BA blocks, without Inspector. Separate diagnostic windows have 40 requests per mode, B then A, and include background settlement. Existing host services remain running; scheduling is not isolated.

| Metric | Deployed-source A | Candidate B | B versus A |
| --- | ---: | ---: | ---: |
| JSON EOF p50, ms | 13.349 | 14.702 | +10.14% |
| JSON EOF p95, ms | 17.791 | 25.948 | +45.85% |
| SSE EOF p50, ms | 69.205 | 69.975 | +1.11% |
| SSE EOF p95, ms | 95.970 | 93.457 | -2.62% |
| SSE first semantic p50, ms | 48.436 | 48.257 | -0.37% |
| SSE first semantic p95, ms | 59.171 | 72.490 | +22.51% |
| JSON sampled non-idle, ms/request | 14.873 | 21.211 | +42.62% |
| SSE sampled non-idle, ms/request | 67.164 | 73.875 | +9.99% |
| JSON settled used heap, MiB | 27.466 | 26.994 | -1.72% |
| SSE settled used heap, MiB | 32.056 | 26.787 | -16.44% |

JSON EOF medians are higher in all four B blocks, by 1.750, 0.341, 2.165 and 2.297 ms. SSE EOF differences change sign (-7.712, +2.132, +16.553, -5.885 ms), as do first-semantic differences (-3.379, +1.899, +7.869, -4.187 ms). The near-equal SSE aggregate medians do not establish a stable speedup; tail results still matter.

CPU values are sparse weighted V8 samples: JSON has 73/143 samples and SSE 282/354 for A/B. Sample weights do not cover the entire wall window. These numbers include observation/settlement work and are neither process CPU nor Cloudflare billed CPU. The large JSON difference is retained as a measured warning, without assigning it to one function or to this increment.

Heap is settled `usedSize`, without forced GC. A and B start from different heaps, and SSE starts at the preceding JSON settled value. This is not peak memory, RSS, leak proof, admission-capacity evidence or Cloudflare-limit qualification.

The [previous experiment](../2026-10-03-ordinary-hot-path/results.md) observed B JSON/SSE EOF p50 of 14.609/71.782 ms, versus 14.702/69.975 here; B sampled non-idle time was 13.363/75.637 ms/request, versus 21.211/73.875 here. These are **separate-run descriptions**, not a paired estimate of the two changes. A also changes between runs. No causal improvement or regression percentage for this increment can be inferred from that comparison.

Fresh profile ancestry and physical frozen-bundle bodies provide two product leads: `ConfigurationCache.copy` still defensively clones configuration rows, and the raw SSE body passes through both the diagnostic collector's pull loop and affinity's cancellation pull loop. Existing configuration pinning, lazy provider/projection work and lazy dial preparation already apply; they should not be proposed again as new work. gzip samples belong to separate eager-request, terminal-sidecar and canonical-response phases. A B JSON two-sample bucket carrying 97.396 ms of weight instead belongs to the harness's `pending.delete` settlement reaction. It cannot be assigned to product code, treated as callback duration or subtracted from the reported CPU result. `formal-01-profile-notes.md` in the raw root records the checked bundle anchors, ancestor chains and 19 input hashes. These establish mechanisms, not removable cost estimates.

## Correctness and storage

| Oracle, 126 matrix cells per variant | A failures | B failures | Regressions | Improvements |
| --- | ---: | ---: | ---: | ---: |
| Client wire semantics | 19 | 0 | 0 | 19 |
| Persisted response fidelity | 4 | 0 | 0 | 4 |

The additional gate independently checks all 358 B requests, including warmups and diagnostics: zero wire failures, zero capture failures and one sidecar per request. These are preserved earlier correctness gains, not 19 or four new fixes in this increment. Checking only A-pass/B-fail would not preserve every previous candidate success.

Canonical domains remain distinct: JSON producer semantics, SSE frame values/DONE with the reviewed renderer-appended-error rule, or exact bytes. The inherited Responses-from-Messages JSON policy-refusal cell retains HTTP 200 with a failed policy envelope and dump status 502; no general status equality is claimed.

| Formal storage, 358 requests each | A | B |
| --- | ---: | ---: |
| Owned objects | 716 | 1,074 |
| Request compressed bytes | 98,038 | 98,090 |
| Response compressed bytes | 140,283 | 140,366 |
| Upstream compressed bytes | 0 | 512,435 |
| Total compressed bytes | 238,321 | 750,891 |

Every B sidecar is retained: 337 EOF and 21 cancelled captures under the existing terminal contract. All dispatches occur exactly once and all background work settles. Capture cancellation does not imply cancelled fixture transport. Responses snapshot/item counts remain zero. Repetitive synthetic input compresses unusually well, so these sizes are not a production storage forecast.

## Remaining gaps and next priorities

1. Investigate a private request-owned configuration projection across visibility-list merging and routing preparation, and composition of the adjacent collector/cancellation transport pumps. First establish owner overlap and equivalent terminal behavior; keep public configuration copies and mutable attempts independent, and preserve raw-byte sidecars, lazy demand, cancellation, lock/listener cleanup and exact EOF/error accounting. This increment retains necessary graph allocations and native compression work. Its ordinary fixture is dominated by a large string rather than many containers, and successful responses do not exercise empty-response finalization, so metrics cannot isolate either improvement. Keep harness bookkeeping distinct when ranking the next changes; do not weaken isolation or disable diagnostics for a better number.
2. Qualify large requests, concurrency and slow consumers with actual capture-budget saturation and admission/queue pressure. This is the main unresolved evidence for the original memory-limit problem. Hosted-search and queue saturation also need their own workload. Ordinary settled heap cannot close these gates.
3. Finish [catalog/affinity rollback compatibility](../2026-10-01-resource-capacity-policy/rollback-readiness.md): select a compatible rollback artifact, switch real SQLite/D1 data between old and new code, and verify backup/restore. The deployed tag alone is not a recovery demonstration.

Retaining these local contract-preserving changes does not authorize or recommend CFW deployment. Resource qualification and data-compatible rollback remain release requirements.
