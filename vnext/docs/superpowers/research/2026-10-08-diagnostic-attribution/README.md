# B diagnostic observer experiment

This extends the completed [A/B/R local comparison](../2026-10-07-reference-stage-measurement/warm-pilot-results.md). It localizes B diagnostic-path work using the same frozen product/runtime inputs, without changing product behavior. See [results](results.md), [machine-readable summary](summary.json), [source audit](source-audit.md) and [implementation plan](../../plans/2026-10-08-diagnostic-attribution.md).

## Fixed design

- B only, 64 KiB JSON string ingress, concurrency one, 20 ms deterministic upstream.
- Native diagnostic retention 3600 versus NULL; history off; usage/performance remain enabled.
- Observer modes `none`, `attached`, `cpu`; two reversed orders. Twelve fresh workerd/storage windows, each 5 warmup + 30 timed: 420 total requests.
- Full window IDs have equal lengths. Normalized complete upstream requests must be identical within each phase across cells, observer modes and blocks. Warmup/timed phase labels differ in length and are validated separately using the existing fixture contract.
- CPU interval 1000 microseconds, exact Inspector target. No source hooks, heap queries, forced GC or concurrent sampler.
- Process bracket: OS start sample → Profiler.start (CPU mode) → timed requests → settlement → Profiler.stop → raw profile save → OS end sample. Native storage readback follows that bracket.
- Fresh non-detached children inherit an owned outer group. Inner timeout 120 s; outer timeout 1200 s. No automatic retry, selected rerun, or pooled failure.

## Evidence and validation

`harness/run.ts` freezes product, harness, runtime and mapping-library inputs before collection. Per-window journals retain offers, raw downstream wire, upstream dispatches, SQL/R2 native evidence, resource samples, exact observer target, raw profile, host command envelopes, and cleanup disposition. Offline analysis requires exact populations, successful terminals/settlement, native semantics, and ownership/cleanup.

Profile validation rejects missing samples/deltas, mismatched populations, invalid times, unknown IDs, cycles/multiple parents, and unreachable nodes. Source attribution checks both source maps and original sourcesContent against frozen bytes. It uses exclusive leaves and preserves idle, GC, native/runtime, harness and unresolved buckets. Sparse samples remain sparse; no tail redistribution or process-CPU scaling is performed. `sourceMappingQualified` means the two-level map proof was constructed, not that every sampled frame was resolved or that sample coverage is sufficient.

### Frozen Bun source-map convention

The saved Bun 1.3.0 maps count each CRLF as two generated lines while original source coordinates remain physical. The frozen B bundle contains thirteen CRLFs in a tslib comment. Default physical-coordinate validation rejected 133,714 entry and 132,105 bundle segments; explicit generated-coordinate correction validated all 875,788 segments. Six persistence-function anchors independently map to their original definitions.

The analyzer explicitly selects `bun-1.3.0-crlf-double` at each generated lookup, using each file's own CRLF positions. It does not rewrite maps, shift every frame by a constant, or double-count original source coordinates. Bare CR is rejected. Physical coordinates remain the default for unrelated maps. Raw profiles are retained even if mapping fails.

## Reproduction

Use existing installed dependencies; do not install or access production. Run from the repair worktree, preserving every prior output directory:

```sh
bun test vnext/docs/superpowers/research/2026-10-08-diagnostic-attribution/harness
bun vnext/node_modules/typescript/bin/tsc --project vnext/docs/superpowers/research/2026-10-08-diagnostic-attribution/harness/tsconfig.json --noEmit
bun vnext/docs/superpowers/research/2026-10-08-diagnostic-attribution/harness/run.ts --manifest ABSOLUTE_FROZEN_MANIFEST --out ABSOLUTE_NEW_RUN_DIRECTORY
bun vnext/docs/superpowers/research/2026-10-08-diagnostic-attribution/harness/analyze.ts ABSOLUTE_RUN_DIRECTORY ABSOLUTE_NEW_ANALYSIS_JSON
```

The separate `remap.ts RUN_DIR NEW_REMAPPED_JSON` command revalidates collection and then resolves the exact workerd-relative entry URL. This fixed-experiment command expects the original analysis at `RUN_DIR/../analysis-02.json`. It writes a new receipt with its own analysis-tool identities; it never edits the raw run or original report.

## Interpretation limits

Two reversed blocks explore observer effects; they do not establish a general overhead/noise bound or stable hotspot ranking. Process CPU includes local workerd storage/native work and profiler commands; it is not billed CFW CPU. Sample weights measure preceding wall intervals, not function duration or CPU. Client EOF is not TTFT. RSS endpoints are neither peak nor isolate memory. No deployment or release qualification follows from this experiment alone.
