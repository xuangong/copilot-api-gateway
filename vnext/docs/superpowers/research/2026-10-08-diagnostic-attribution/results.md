# Diagnostic observer results — 2026-10-08

The complete second attempt passed all 12 windows and 420 requests, including wire/dispatch contracts, saved native SQL/R2 semantic replay, settlement and process cleanup. Independent Python arithmetic matched every window's CPU, EOF and RSS value.

The experiment does **not** support fine-grained function cost attribution: enabling CPU profiling increased observed whole-process CPU, while the four raw profiles contained only 58 samples. Keep the current diagnostic/ownership architecture and prioritize bounded allocation changes with explicit contracts. Do not remove guarantees or rank functions by these sparse wall-interval weights.

## Identity and failure disposition

Product B is unchanged: manifest `05f341af-02b0-4c30-8c5d-9958b29ac722`, source freeze `cb5ca3b17736dabc6f217c36d3961a40f111cfe5` plus its recorded overlay/assets. Frozen Bun 1.3.0, Miniflare 4.20260601.0 and workerd 1.20260601.1; compatibility date `2025-06-01`, flags `nodejs_compat` and `enable_ctx_exports`. No product optimization, push, deployment or production read occurred in this task.

`observer-01` stopped after its first 35 successful requests when post-envelope evidence capture attempted `structuredClone` on a Miniflare R2 inventory object containing noncloneable runtime behavior. Workerd disposal, fixture shutdown and outer group cleanup succeeded. This is a harness readback failure, not a request/product failure; the incomplete window is excluded entirely from results. Its raw artifacts and original failed input are retained.

The correction snapshots only the oracle's `{truncated, objects: [{key,size}]}` fields and leaves the live R2 return value untouched. A fixture with functions and a Proxy reproduced the failure before the fix. `observer-02` uses a new frozen tool-input set and a complete fresh matrix. There was no automatic retry, favorable-window selection or pooling between attempts.

Both cells use 64 KiB JSON string requests and 20 ms synthetic upstream delay, concurrency one, history off, native usage/performance on. Every window has 5 warmup and 30 timed offers; warmup is excluded from CPU accounting. Diagnostics full uses 3600-second retention; off uses NULL. Equal-length window IDs preserve identical complete normalized upstream bytes within each phase. The old warmup/timed phase labels differ in length and therefore remain separate equivalence groups.

## CPU and EOF

CPU is Darwin user plus system time for the identified **whole workerd process**, including local storage/native work. The CPU-mode bracket also includes Profiler start/stop commands and saving the profile before the end sample. Gateway-target V8 profiling does not cover every other isolate/native/storage activity inside that process. These values are not CFW billed CPU.

| Diagnostic policy | No Inspector, CPU/request ms | Attached only | CPU profiling | Profiling minus no Inspector |
| --- | ---: | ---: | ---: | ---: |
| full | 7.895 | 8.494 | 10.994 | +3.099 ms / +39.3% |
| off | 4.592 | 4.201 | 6.131 | +1.539 ms / +33.5% |

Entries are means of two equal-sized windows, not statistical overhead bounds. The paired CPU-mode increases were +3.301/+2.898 ms per request for full, and +1.711/+1.367 for off. Attach-only full was +0.599 ms on average, while off was -0.392 ms. That negative difference demonstrates why this small matrix cannot isolate a stable attach-only cost.

Without an observer, full-minus-off was 3.303 ms/request on average (+3.579/+3.026 in the two blocks). This localizes a policy-dependent cost envelope spanning capture, serialization, compression, ownership registration, storage and recorder branches. It is not an additive estimate for a single codec operation.

No product bytes changed between the earlier A/B/R pilot and this experiment. Do not interpret the different absolute CPU numbers across those runs as an optimization or pool them. This B-only run also cannot establish a new B/A or B/R delta.

EOF covers the entire client response, not first-token latency. Exact window observations follow; p50/p95 use nearest rank over 30 timed requests:

| Block | Policy | Observer | CPU/request ms | EOF p50 ms | EOF p95 ms | RSS end MiB |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 0 | full | none | 7.622 | 34.94 | 54.86 | 175.39 |
| 0 | full | attached | 8.052 | 34.96 | 51.17 | 176.77 |
| 0 | full | cpu | 10.923 | 37.87 | 47.84 | 184.05 |
| 0 | off | none | 4.043 | 24.68 | 27.16 | 154.28 |
| 0 | off | attached | 3.733 | 24.66 | 26.34 | 154.08 |
| 0 | off | cpu | 5.753 | 24.36 | 26.11 | 162.70 |
| 1 | full | cpu | 11.065 | 37.11 | 54.07 | 185.20 |
| 1 | full | attached | 8.936 | 38.24 | 49.35 | 177.88 |
| 1 | full | none | 8.167 | 36.02 | 43.81 | 175.52 |
| 1 | off | cpu | 6.509 | 24.86 | 27.11 | 162.12 |
| 1 | off | attached | 4.668 | 25.35 | 28.00 | 153.22 |
| 1 | off | none | 5.142 | 26.51 | 30.20 | 132.64 |

## Profile resolution and interpretation

Requested sampling interval was 1000 microseconds. Observed preceding intervals had a median of **58,503 microseconds** and maximum **289,825 microseconds**. Four profiles contained 16, 10, 19 and 13 samples. The requested configuration does not establish an effective 1 ms sampling resolution.

| Policy/block | Samples | V8 wall window ms | Sum of preceding intervals ms | First interval ms | Unsampled tail ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| full/0 | 16 | 1361.383 | 1259.414 | 62.110 | 101.969 |
| off/0 | 10 | 872.493 | 819.070 | 59.867 | 53.423 |
| full/1 | 19 | 1368.736 | 1268.643 | 65.611 | 100.093 |
| off/1 | 13 | 911.710 | 910.712 | 64.521 | 0.998 |

The 94.3% aggregate interval coverage is a wall-range accounting property, not CPU coverage or sufficient sample density. There are 18 runtime/native, 7 idle, 1 GC and 32 script samples. A large preceding interval assigned to a leaf does not measure how long that function executed. Async roots and native work further limit attribution. Preserve the raw tree; do not redistribute idle/native/tail weights to ancestors or multiply shares by process CPU.

The first offline report preserved all script leaves as unresolved because workerd reports the module URL `entry/entry.mjs`, relative to the configured module root. A separate offline correction uses the frozen runtime's exact single-module declaration to resolve only that known relative URL to the window's hashed entry. The original report and raw profiles remain unchanged. Two-level source mapping additionally uses the explicit frozen Bun CRLF convention described in [method](README.md). After correction, 27 samples map to product source, 2 to dependencies and 1 to harness code. Two `cloudflare-internal:d1-api` samples remain unresolved; they are not assigned to product. The other 26 samples remain runtime/native, idle or GC. Every mapped product leaf appears only once. Diagnostic preparation, live upstream resolution and frame/affinity handling were exercised, but no function ranking follows. Valid maps do not imply enough samples for a hotspot ranking.

## Memory and architecture decision

RSS values above are process endpoints after settlement, not peaks or isolate heap usage. Full no-observer endpoints were 175.39/175.52 MiB; CPU-mode endpoints were 184.05/185.20 MiB. Off endpoints varied more (132.64–154.28 MiB without Inspector). These local workerd numbers include more than the gateway isolate and cannot be compared directly with a CFW isolate limit. No heap/backing series, peak reduction or memory-limit resolution is claimed.

[Source audit](source-audit.md) finds existing fast paths across ingress, capture, immutable projection, compression, transfer, upload and commit. Preserve those stages and contracts. The evidence does not justify an architecture rollback or removing upstream diagnostics, mutation protection, cancellation distinctions, ownership triggers, or delayed reservation release.

## Next work

1. **Remove multi-page Base64 concatenation scratch under the existing capture contract.** The current extra contiguous binary allocation is source-proven and bounded. Use a page-aware encoder with carry across page boundaries; preserve canonical bytes, truncation, owned/borrowed snapshots and release/error behavior. Validate the actual change with realistic page/body boundaries before making a performance claim.
2. **Evaluate owned-string gzip input as a narrow implementation alternative.** R's direct enqueue approach is useful reference, but an explicit TextEncoder buffer may offset Blob savings. Keep serial compression and public borrowed-byte snapshot semantics. Compare the complete diagnostic policy with and without that implementation change using uninstrumented workerd.
3. **Narrow live terminal upstream metadata loading** if it remains worthwhile after body-dependent work. Preserve live rename/delete and exact broker publication semantics; do not replace it with stale pinned configuration.
4. **Qualify memory sampling separately**, then measure larger body/frame slopes, slow readers, cancellation and settlement. Do not combine a new memory sampler with this perturbed CPU profiler, and do not repeat a large general profiler matrix before solving its resolution limitation.

Open release gates: true resource-pressure evidence under representative payload/concurrency; large/slow/cancel stability; catalog/affinity rollback compatibility; prior data/rollback requirements. This experiment closes observer/integrity tooling work, not release readiness.

See [evidence index](evidence-index.json) for raw local artifact hashes and independent verification; [plan](../../plans/2026-10-08-diagnostic-attribution.md) tracks completion. Failed and complete attempts remain separate.

Validation: 184 focused tests / 1,452 assertions passed, strict harness TypeScript check passed, and independent code/numeric/interpretation reviews found no blocking issue. Product CI was not rerun because no product implementation or dependency changed.
