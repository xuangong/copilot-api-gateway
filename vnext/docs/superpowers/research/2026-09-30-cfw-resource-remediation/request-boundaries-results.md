# Request boundary implementation and local evidence

Date: 2026-09-30

This report tracks the bounded architecture batch in the [implementation plan](../../plans/2026-09-30-cfw-request-boundaries.md). It is not a CFW deployment authorization. Production Workers, remote bindings and Docker services are outside this batch.

The three source changes are complete and integrated into local `vNext` through `298f37b8`. Functional CI passed on the frozen repair workspace; **the complete local performance comparison is unfinished**. Workerd initialization stalled in the last two attempts, so no CPU/heap improvement or CFW resource qualification is claimed. The [metrics ledger](./request-boundaries-local-metrics.json) records separate attempt outcomes, artifact identities and 66 raw-evidence hashes. Nothing was pushed or deployed.

## Baseline identity

The before artifact was built from repair HEAD `54f1a4e43ea3bedebff16b362c3378a6cf841c80` plus the existing collaboration overlay. It includes the UI/setup assets actually imported by the Worker build. This is the immediate pre-architecture repair candidate, not the older deployed CFW version.

- Source manifest: 1,534 files, 10,624,696 bytes; SHA-256 `bd010dd6ecc26c2b7e1cf17f90d8c6c11ecbe24e3f2d9d3db3c17433f2f469bc`.
- Executable Worker bundle: 5,027,639 bytes; SHA-256 `8f64f80c6f1aeca1678334b1074cd313644d3da42b09c39d17c3162e7396309c`.
- Bun build and `node --check` passed. All source hashes were unchanged across the build. The initial failed sourcemap invocation and the corrected build receipt are retained.
- Local tools: Miniflare `4.20260601.0`, workerd `1.20260601.1`; no dependency installation or source/worktree copy was needed.

Raw receipts live in the ignored plan workspace `.superpowers/sdd/2026-09-30-cfw-request-boundaries/before/`. Product implementation began only after this freeze completed.

## Implementation status

| Boundary | Status | Intended effect |
| --- | --- | --- |
| Responses source preparation and controller ownership | Focused tests, independent review and integrated CI passed | Separate body/event translation from turn lifecycle and reuse its upstream controller. |
| Immutable routing projection and explicit materialization | Focused tests, independent review and integrated CI passed | Reuse static model data; ordinary routing creates only the first usable provider, while owned affinity retains full eligible ranking. |
| Request background scheduler | Focused tests, independent review and integrated CI passed | Bind catalog refresh and dump publication to the originating request capability. |
| Integrated functional validation | Frozen CI passed, including local workerd HTTP/WS tests | Verify the complete workspace with its preserved overlay. |
| Full local performance comparison | Incomplete; workerd initialization stalled in final-04 and final-05 | CPU/heap and final comparison remain unavailable; no sixth run in this batch. |

The initial integrated CI exposed an eager scheduler bootstrap regression: all 71 failures came from resolving the background executor before non-scheduling catalog reads and proxy/repo/runtime preflight. The fix captures a stable missing capability that throws only on actual scheduling, preserving the previous failure policy without borrowing a later request's executor. Independent scoped review passed; all 71 cases passed in the 380-test focused run. The original failed CI evidence remains retained.

## Integrated candidate verification

- Final `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local`: **5,427 pass, 1 skip, 0 fail**, 229,131 assertions across 522 files; exit 0 in 138.732 seconds. Framework purity, all typechecks, lint, UI/setup builds and Worker dry-run passed. The 35 existing lint warnings remain.
- Existing local workerd HTTP/WebSocket tests are included in this suite. No production binding or service was exercised.
- Source: 1,539 files, 10,676,943 bytes; after manifest SHA-256 `cd8d5b8945d57994c5e3c8deeda787aaa3c6cce043f29c614caeaeca25adeda8`. Every source hash remained identical across CI and the comparison-bundle build.
- After bundle: 5,033,884 bytes; SHA-256 `a41ab4928a797ffd2e37e5f6c55c6aca58b8344ca11494779331176401ad1a6e`. Same Bun build options as the baseline; `node --check` passed.
- The 29 architecture/test files are the only product-input changes from the frozen baseline. The existing collaboration overlay is preserved in both artifacts; a source commit excluding that overlay is not the complete tested artifact.

The comparison uses identical local workerd settings, fixed synthetic upstreams, retained dump capture, explicit EOF/background settlement and physical D1/R2 readback. Only local D1/KV/R2 and the allowlisted loopback fixture are used. The planned 716 requests comprise 144 warmups, 160 timing requests, 252 matrix cases and 160 diagnostic requests. Numeric dump retention 0 enables capture; Responses retention 0 disables history. This comparison did not finish and is not an enabled-history or production resource qualification.

## Measurement reader corrections and retained failures

All failed runs remain separate from a complete comparison; their partial timings are not pooled into a successful batch.

- `runs/final` stopped after 24 baseline warmups. The reader expected SSE text deltas in native JSON Responses capture, which contains complete output items. Body and event projections now have separate validation paths.
- `runs/final-02` stopped after 358 requests, including both warmed latency workloads and all 126 baseline wire cases. Five stored partial-failure traces had no output-layer error frame, but did have real failed-settlement metadata. Capture validation now accepts that evidence only on its own failure path; wire validation still requires actual fault output. All 358 stored cases replayed offline: 322 event traces and 36 byte digests passed.
- Independent review also found that the wire oracle could forget an earlier successful terminal when a later failure arrived. Success observation is now sticky; offline negative cases prove that completed-then-failed fault fixtures are rejected. Captured-success checks remain specific to the fixed failed/truncated fixtures, not a general equivalence between capture and successful delivery. The final reader checks passed 43 offline assertions.
- `runs/final-03` stopped after 358 requests at a scalar metadata comparison. Responses over Messages, JSON policy refusal returns HTTP 200 while the existing turn stores dump status 502 for its internal failed outcome. The before and after bundles have the same status mapping. All 358 records' other checked scalar fields matched. The reviewed reader now accepts only this exact fixture mapping, with completed transport, strict wire/canonical refusal validation and real failed metadata. It records both statuses explicitly. The final 57 offline assertions passed; all 358 records and 1,074 owned objects passed the remaining physical checks. Independent host-prefix evidence covers 208 requests; the other 150 retain their missing-host-evidence boundary.
- `runs/final-04` passed both latency settlements and the complete baseline matrix/physical readback, then stalled during the next local workerd initialization, before after-matrix warmup or inference. A `Broken pipe` runtime message was retained. After recording process identities, only this run's stalled workerd child and runner were stopped. Bun returned exit 0 on termination, but no completion marker, final request journal or summary was produced; this run is **incomplete, not successful**. The original fixture service was preserved. No product or reader change was inferred from this infrastructure symptom.
- `runs/final-05` was the one fresh-process repeat, with an external 120-second deadline. Both variants' latency and matrix phases left dispatch, dump and settlement receipts. The next workerd initialization stalled at after/diagnostic before any diagnostic warmup, again with `Broken pipe`. The deadline stopped only this run's process group. Exit 0 again lacks a completion marker, final wire journal or summary: `completed=false`, `outerDeadlineExceeded=true`. No sixth run was performed.

The matrix dispatch receipt was not written when final-02/final-03 stopped during settlement readback. Offline storage checks do not reconstruct or replace that missing original host receipt. Product source, bundles, fixture settings and previous failure artifacts are unchanged by reader corrections.

## Final partial accounting and measurement limits

`final-04` independently accounts for 358 logical requests. `final-05` independently accounts for **508 logical requests**: 96 warmups, 160 timing requests and all 252 planned matrix requests. Its physical records contain 1,524 owned R2 objects, 22 settlement receipts and four independent dispatch receipts. Within those receipts, exactly-once failures, unexpected/rejected egress, cancelled dispatches and pending background tasks are all zero. Responses snapshots/items are zero, consistent with disabled history. The before/after JSON policy-refusal cases each retain the explicit HTTP 200 / dump 502 mapping described above.

This proves the recorded dispatch, capture and settlement facts, **not a complete wire-matrix verdict**. The final original wire journal and wire-oracle aggregate were never persisted. The remaining 208 planned requests were not executed; no CPU profile or settled-heap result exists. Final-05 latency quantiles cannot be recovered from the surviving dispatch/dump receipts. Different attempts are not stitched together to replace the missing comparison.

Earlier attempts did persist these partial latency phases; each cell contains 40 requests per variant and mode:

| Attempt | Mode | Before p50 / p95 ms | After p50 / p95 ms |
| --- | --- | ---: | ---: |
| final-02 | JSON | 15.653 / 19.396 | 14.673 / 17.255 |
| final-02 | SSE | 63.483 / 80.611 | 64.458 / 76.248 |
| final-03 | JSON | 14.531 / 22.027 | 15.116 / 19.862 |
| final-03 | SSE | 60.330 / 72.497 | 64.910 / 77.873 |

These directions are mixed, the attempts failed later, and their quantiles are not pooled. They neither establish an overall speed gain nor supersede the earlier [cloud resource regression](./source-optimization-results.md), which compared a different candidate against the deployed baseline.

All 1,539 frozen candidate inputs, eight final harness files and both comparison bundles remained unchanged through the final attempts. The original fixture process, PID 90455 with start time `Wed Sep 30 05:16:07 2026`, was preserved. Run-owned processes from final-04/final-05 were stopped and their shutdown evidence retained. The ignored workspace and repair worktree remain available; no dependencies or evidence were removed.

## Product commits

- `bb4fca4a`: Responses source preparation and cancellation ownership.
- `116e49a5`: Reusable routing projections and deferred provider construction.
- `298f37b8`: Request-owned background scheduling, including deferred missing-capability failure.

These commits exclude the inherited collaboration overlay. Local `vNext` was fast-forwarded from `42b20f31` to `298f37b8`, including the preceding repair history. Integration review approved the functional source changes independently of the incomplete performance comparison; push and deployment remain outside this batch.

The original ten tracked overlay paths remain unstaged, and all 27 original untracked files remain unchanged. Of the original 37 dirty/untracked files, 36 remain byte-identical; the overlapping Responses `attempt.ts` retains the reviewed combination of controller reuse and `onEvent: diagnose`, matching the tested repair file. There are no unresolved conflicts or staged product changes.

After integration, 1,530 frozen source inputs match the main checkout. Nine ignored generated imports retain their original main-checkout state: five setup files were absent and four dashboard assets differed. Therefore the functional CI/build qualification belongs to the frozen repair workspace, not a claim that the main checkout already has its identical executable bundle. No rebuild was performed during integration.

## Remaining release boundaries

The Responses adapter does not remove the legacy cross-protocol execution-result cast elsewhere. Global ambient request/background services also remain in use outside the migrated seams. This batch does not change stored formats, migrations, diagnostic defaults, or required snapshot-before-success ordering.

Catalog legacy-writer and affinity old-reader rollback compatibility remain separate CFW release gates. Item-reference history storage and dashboard aggregates need their own migration and total-operation cost designs. A later settlement contract should explicitly distinguish HTTP status, semantic outcome and diagnostic status; this batch preserves the existing policy-refusal mapping described above.

Local workerd latency, Inspector CPU samples and sampled JavaScript heap describe different measurements. They cannot be reported as production billed CPU or a guarantee about the Cloudflare shared-isolate memory limit.

Next priorities are to isolate and bound measurement phases with durable per-request wire journals before collecting the missing CPU/heap comparison; then consolidate settlement facts and diagnostic policy without weakening lifecycle guarantees. Catalog/affinity rollback compatibility and combined enabled-feature/fault/soak qualification remain required before CFW release. No further test or measurement run belongs to this closeout.
