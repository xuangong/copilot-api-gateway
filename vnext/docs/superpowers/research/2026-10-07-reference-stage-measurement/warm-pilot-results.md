# Local three-arm workerd pilot results — 2026-10-08

The first complete warmed pilot passed: 108 independent windows, 540 warmup requests and 2,160 timed requests. All 2,700 requests passed client-wire, dispatch, native side-effect, settlement and cleanup validation. A post-run aggregation reread the saved artifacts; a separate Python reviewer independently recomputed the numbers without reading the generated summary. Both passed.

Candidate B uses less whole-process CPU than reference R in all six aggregate cells, but remains more expensive than frozen deployed baseline A in several diagnostic-enabled cells. This supports targeted investigation of the diagnostic path. It does not establish release readiness or justify a general architecture rollback.

## Identities and method

| Arm | Frozen program |
| --- | --- |
| A | Deployed-baseline source `e660fb4dfcf1734d10f89e52e2d739b2985c634b` |
| B | Candidate product freeze `cb5ca3b17736dabc6f217c36d3961a40f111cfe5`, including manifest-recorded overlay/assets; current product bytes were revalidated |
| R | Reference checkout `1d7dcd923e260e425120cca0c7a240e93720af27`, built in an isolated archive with its unchanged dependency lock |

A/B manifest ID: `05f341af-02b0-4c30-8c5d-9958b29ac722`. Subsequent task commits changed tools/docs; a branch HEAD alone is not the measurement identity. Compiler inputs and artifacts are checked against their frozen hashes.

All arms use Bun 1.3.0, Miniflare 4.20260601.0 and workerd 1.20260601.1 on this Mac. Actual compatibility date: `2025-06-01`; flags: `nodejs_compat`, `enable_ctx_exports`. The second flag differs from the earlier A/B manifest default and is explicit for all three arms here. Do not pool these measurements with earlier experiments.

Six permutations of A/B/R order each contain all six cells. Every window has a fresh Bun host, workerd process and D1/R2/KV storage, with five warmup and twenty timed requests, concurrency one. Ingress is exactly 65,536 bytes; containers add 128 small messages while preserving that size. The synthetic upstream has a fixed 20 ms delay. Diagnostic retention is 3,600 seconds when enabled, NULL when disabled; response history is disabled.

Source hooks, Inspector and heap collection are off. CPU starts after successful warmup settlement and ends after timed-request settlement, before readback. Each cell/arm has 120 timed observations across six windows. Quantiles use nearest rank and are exploratory, not robust tail estimates. The run took about 450 seconds including setup, builds and readback.

## CPU and latency

CPU is Darwin user plus system time for the identified whole workerd process, including local Miniflare storage services. It is neither isolate-only CPU nor Cloudflare billed CPU. Latency covers client request start through full response EOF, not first token or first semantic output. Host evidence journaling introduces inter-request idle time; this is not a throughput/capacity test.

| Cell | CPU/request A / B / R (ms) | B vs A | B vs R | EOF p50 A / B / R (ms) | EOF p95 A / B / R (ms) |
| --- | --- | --- | --- | --- | --- |
| `sse-string-full` | 9.80 / 11.22 / 15.93 | +14.5% | -29.6% | 34.49 / 41.16 / 44.18 | 67.18 / 69.31 / 72.54 |
| `sse-containers-full` | 10.65 / 13.80 / 16.77 | +29.6% | -17.7% | 35.72 / 42.65 / 43.14 | 66.56 / 75.71 / 70.26 |
| `sse-string-common` | 5.96 / 6.58 / 8.83 | +10.4% | -25.6% | 26.77 / 27.53 / 30.06 | 30.36 / 35.14 / 38.97 |
| `json-string-full` | 10.83 / 13.39 / 16.71 | +23.7% | -19.8% | 35.50 / 43.61 / 46.92 | 55.24 / 63.19 / 77.39 |
| `json-containers-full` | 13.13 / 12.52 / 16.93 | -4.7% | -26.1% | 40.39 / 41.13 / 46.38 | 71.97 / 62.30 / 81.33 |
| `json-string-common` | 5.60 / 5.60 / 8.23 | -0.0% | -32.0% | 25.89 / 25.87 / 30.26 | 34.59 / 33.85 / 42.11 |

`full` preserves each implementation's native diagnostic guarantees. `common` means diagnostics disabled; it does not assert equal total work. CPU per successful request equals CPU per offered request because all requests succeeded.

Block variation matters. B/A CPU differences change sign in every cell; the SSE-container-full difference ranges from -7.4% to +101.7%. B uses less CPU than R in all six blocks for five cells; JSON-string-full has one reversal. The aggregate direction helps choose an investigation, but small differences are not established production regressions.

| Cell | B/A CPU block differences (%) | B/R CPU block differences (%) |
| --- | --- | --- |
| `sse-string-full` | +21.5, +20.7, +15.5, -1.6, +27.3, +13.3 | -43.1, -17.0, -20.6, -29.5, -31.9, -24.1 |
| `sse-containers-full` | +44.1, +8.5, -7.4, +101.7, +21.2, +19.6 | -15.7, -22.1, -7.6, -24.3, -13.2, -20.0 |
| `sse-string-common` | +6.1, +53.8, -7.0, +16.0, -1.5, +4.7 | -33.2, -15.7, -29.8, -20.0, -33.1, -19.9 |
| `json-string-full` | +76.0, -19.2, +80.1, +2.7, +12.0, +19.1 | -30.6, -24.0, +26.8, -25.7, -20.9, -29.1 |
| `json-containers-full` | -18.7, +6.7, +4.2, -0.6, -21.6, +1.2 | -17.8, -1.8, -34.3, -37.0, -50.7, -0.7 |
| `json-string-common` | -3.8, +4.9, -9.6, +18.0, -13.0, +4.4 | -42.9, -36.9, -27.5, -16.3, -39.9, -37.3 |

## Memory evidence

These are whole-process RSS endpoints only. Each median below uses six window-end samples. Local storage services, allocator state and GC contribute. Process RSS does not establish isolate-limit pressure; no memory peak, sustained retention or leak conclusion is available.

| Cell | Median RSS end A / B / R (MiB) | End range A | End range B | End range R |
| --- | --- | --- | --- | --- |
| `sse-string-full` | 154.0 / 172.4 / 201.1 | 152.4–154.7 | 171.1–174.1 | 147.9–201.5 |
| `sse-containers-full` | 154.5 / 175.5 / 201.9 | 128.1–154.9 | 122.3–177.2 | 149.1–204.5 |
| `sse-string-common` | 144.4 / 154.4 / 187.8 | 142.6–146.3 | 154.3–154.7 | 143.2–188.5 |
| `json-string-full` | 154.1 / 164.9 / 201.2 | 153.3–155.3 | 163.6–166.6 | 168.8–206.1 |
| `json-containers-full` | 154.0 / 168.6 / 188.1 | 125.1–155.3 | 165.1–170.2 | 168.5–204.3 |
| `json-string-common` | 143.8 / 150.9 / 180.6 | 105.6–145.7 | 122.5–154.2 | 141.8–188.2 |

B's median RSS endpoint exceeds A by roughly 7–21 MiB across these cells and is below R's median endpoint. This does not substantiate a memory reduction versus the deployed baseline. A time series with isolate heap/backing-store attribution remains necessary.

## Native differences and source-stage evidence

R always produces an authenticated affinity carrier, including when diagnostics are disabled. A/B do not produce one for this synthetic provider response without an existing opaque signature. R also separates usage into its own SSE event. The same visible answer and 7 input/3 output tokens therefore require different encryption, framing and output work. Cold qualification wire was 683 bytes/3 SSE events for A/B versus 1,327 bytes/5 events for R; JSON was 289 versus 607 bytes. Warm wire identities and lengths were checked from their own artifacts.

Only SSE-string diagnostics-off matches both ingress shape and upstream source format. A/B JSON cells use JSON upstream; R uses SSE and folds to JSON. Those comparisons include native conversion. Raw B/R CPU differences cannot be interpreted as pure implementation efficiency.

Cold source-hook qualification confirmed one provider call and one HTTP dispatch per request; SSE parsing consumed four upstream frames. A uses two compression calls/file puts per diagnostic request; B and R use three. A lacks B's complete upstream sidecar. B compression observes 65,536 input bytes plus about 89–90k UTF-16 code units; R observes about 134–135k bytes. These differently typed counters are neither directly comparable memory sizes nor CPU attribution. They do not explain a measured millisecond difference on their own.

The R oracle follows its native contracts: record IDs are correlated through unique stored request markers and complete request bytes, without inventing a response header. Canonical output precedes affinity egress; the single carrier is cryptographically verified. Its upstream parser stops at DONE, so exact complete raw wire and an independently completed fixture can coexist with `capture.complete=false`; the receipt retains that state. JSON captures still require EOF completion. These are measurement-adapter corrections, not product fixes.

## Next work and release gaps

1. Profile B's diagnostic-enabled path against its disabled control: request preparation, canonical/upstream serialization, compression, file ownership registration and SQL/file persistence. JSON string averages change from A/B 5.60/5.60 ms CPU without diagnostics to 10.83/13.39 ms with diagnostics. This is a localization clue, not additive causal allocation across independent windows. Preserve full capture and completion guarantees while finding avoidable copies, conversions and writes.
2. Inspect diagnostics-off SSE frame/telemetry wrappers after the larger diagnostic path. Its aggregate B/A difference is 0.62 ms CPU and 0.76 ms median EOF, with mixed block signs; profile before treating the percentage as a proven regression.
3. Qualify separate V8 CPU-profile and heap/backing-store/RSS time-series windows, including observer overhead. Then measure body-size/frame-count slopes and retained ownership under slow readers/cancellation. Endpoint data cannot close the original memory-limit concern.
4. Keep catalog/affinity rollback compatibility and backup/restore gates separate. This pilot does not qualify CFW deployment.

## Execution and evidence

Fresh-host `qualification-ab-03` and `qualification-reference-07` passed before `warm-pilot-01`. All 108 pilot children exited normally with empty owned groups; outer supervision reports cleanup complete. Earlier failures remain preserved: R bootstrap/catalog/base-URL and oracle assumption failures, plus two A/B readiness failures. One emitted a broken fd 3 control pipe. Twenty-four minimal shared/fresh-host startup trials did not reproduce it. Fresh hosts completed this run; the low-level cause remains unproven.

Validation: 131 tests, 808 assertions, zero failures; strict harness TypeScript check passed. Independent integrity review verified three runs' 53 frozen executable input files, R's 1,395 compiler inputs, MAIN's 38 protected files and the repair checkout's 14 protected files. Reference HEAD remains clean. Raw R bundle hashes vary with generated source-path/debug-ID comments; the review records those differences rather than claiming raw hashes match across build directories.

No product runtime behavior or dependencies were changed. No production access, push or deployment occurred; existing product edits and all earlier evidence remain protected.

- [Machine-readable summary](warm-pilot-summary.json)
- [Hashed evidence index](warm-pilot-evidence-index.json)
- [Harness commands and contracts](harness/README.md)
- [Updated execution plan](../../plans/2026-10-07-reference-stage-measurement.md)

Offline validation reopens saved storage evidence and wire artifacts; it is not a second physical R2 read. Original runtime physical reads completed before disposal. `warmComparisonCompleted=true` and `comparisonQualified=true` refer to this pilot; `comparisonCompleted=false` retains the outstanding profile, peak and stress work.
