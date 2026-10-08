# Matched upstream SSE workerd study

Status: correctness canaries and source analysis complete; `cpu-02` CPU/latency and `memory-03` sampled-RSS comparisons are qualified and independently audited. The failed `memory-01` and `memory-02` attempts remain separate. Overall correctness qualification remains false. Study commit `e3b7284a` is integrated into local `vNext`; nothing was pushed or deployed. No product code is changed by this study.

## Frozen inputs and scope

- Runtime: Bun 1.3.0, Miniflare 4.20260601.0, workerd 1.20260601.1; compatibility date 2025-06-01.
- B: vNext `963305f85654ff9b4fac28132739ec7ec9902e9a`.
- R: reference `1d7dcd923e260e425120cca0c7a240e93720af27`.
- The performance arms use the same installed Miniflare/workerd, compatibility flags, outbound bridge, synthetic upstream fixture and lifecycle settlement wrapper. Correctness canaries instead use direct native workerd-to-Node TCP without the outbound-service bridge. No dependency installation, push, deployment or production access.
- B is a Git archive plus nine explicitly hashed generated UI/setup assets; six of those assets are consumed by the bundle. It is not a commit-only reproducible build. R's isolated tracked source, symlinks and consumed installed dependencies were verified against the checkout/build receipts.
- B bundle: 4,945,710 bytes, SHA-256 `2ab8b9e3611aff1628dfc0bc69e0d54eacfb90cc0eb72d0d84c3409d6a9c42fe`.
- R bundle: 4,091,918 bytes, SHA-256 `afc3a985c4bcf3dde080c31446dbe93d5966dc6913ef0d0093ad132c5a9c118a`.

The authoritative local evidence root is `.superpowers/sdd/2026-10-08-matched-sse-workerd/` in the resource-fix worktree. Generated raw wire and temporary runtime artifacts stay outside Git. The committed [evidence index](evidence-index.json) and [evidence summary](evidence-summary.json) identify their hashes and qualification results.

## Correctness and capability findings

`canary-02` completed all 61 declared cases: 58 passed and 3 failed. No cases are missing, duplicated or unexpected. All 36 common-workload contracts passed. Overall correctness qualification remains false; the supervisor correctly returned exit 1 and completed cleanup.

Successful cases cover native text, split tool arguments, terminal order and usage for the selected Chat, Responses and Messages routes. B additionally passes standard `application/json` fallback. The opaque replay and required-source rejection cases use Responses; cross-protocol opaque continuation is not covered here. An independent raw-wire review separately checked all eight ordinary Chat combinations (B/R, text/tool, JSON/SSE). These are synthetic gateway contracts, not a claim about every SDK, Gemini, live model, concurrency level or production transport.

| Case | Observed result | Interpretation |
| --- | --- | --- |
| B Chat, missing MIME JSON to SSE client | Fails with `stream ended without a terminal event` | Existing format-detection gap; source at `08259855` already takes this path. Old-version runtime was not rerun. |
| B Chat, `text/plain` JSON to SSE client | Same failure | Same gap. Standard JSON MIME fallback succeeds. |
| B Responses, downstream cancellation after first semantic output | No upstream TCP close within the 2.5-second pre-cleanup observation window | Cancellation/resource-release gap. Final native outcome is `cancelled`; it does not establish timely propagation. |

A read-only query of the final `canary-02` D1 records native `firstTextMs=21` and `totalMs=2537` (the earlier diagnostic run recorded 21 and 2538). Together with synchronous `PerformanceRecorder.finish()` and turn `onAbort`, these place the delayed abort between downstream closure and the turn abort callback. The timing coincides with cleanup releasing the upstream gate, without a causal timing hook; the native timing readback is saved separately in `cancel-metric-readback.json`. A direct Node fixture cancellation control observes close while the gate remains closed. This excludes a general claim that Node needs another body write to detect close, but does not isolate the fault to a specific workerd/host/request/renderer layer. No production failure or leak is inferred solely from this observation.

Four separately labeled provenance probes also passed their expected-behavior checks; they expose a functional difference rather than common correctness equivalence. After ordinary Responses output is replayed with a blob-less synthetic `program_output`, a model on another source gets HTTP 200 and one secondary dispatch on B (JSON and SSE). R returns HTTP 400 with zero dispatch in both formats. Those four checks being green does not mean B implements R's provenance contract.

## Why ordinary affinity matters

See [the source and history analysis](ordinary-affinity-analysis.md). Reference ordinary Chat carriers with `decoded.value === undefined` do not currently prefer the old target. No ordinary-Chat cache-hit or stickiness benefit follows from their presence. Natural opaque state still benefits from authenticated compatibility and required-versus-optional routing.

Responses additionally uses the synthetic carrier as an ordered provenance anchor. A later blob-less state item can inherit the authenticated target and must use an authorized compatible source. Current vNext lacks this particular inheritance contract. This study supports retaining lazy ordinary Chat affinity and designing a targeted Responses provenance extension. Any extension needs versioned encoding, whole-item versus metadata-only semantics, foreign-state boundaries and old/new reader compatibility.

## Measurement method

The fixed CPU/latency population is four cells with six alternating B/R pairs per cell: 48 fresh windows, five warmup and twenty timed requests per window (240 warmup plus 960 timed). Requests are 64 KiB; the fixture returns the same four complete upstream SSE frames. Both arms must actually request SSE even for a JSON client. Each request, source body, response wire, usage and native storage record is qualified. The two common cells disable dumps and retained history; full cells preserve each product's own diagnostics, so physical writes and downstream affinity bytes differ.

CPU is the owned workerd process delta through post-request settlement, excluding host fixture/client and physical readback. It is not per-isolate or billed CPU. Latency is client EOF, not first semantic output. Pooled p50/p95 and paired blocks are descriptive observations; no universal ranking or robust tail estimate is claimed. Native B upstream first-output metrics must cover every invocation; a client JSON response is not assigned a fabricated streaming TTFT.

Memory runs separately for the two common cells, three alternating pairs each (12 windows). A persistent libproc sampler requests 20 ms intervals. Actual cadence, endpoint coverage and identity must qualify; gaps above 250 ms fail. The maximum observed RSS includes measured endpoints and in-window samples. It is a lower bound on whole-process peak, not an exact peak, isolate heap, or CFW 128 MiB qualification. CPU/latency from these observer runs are excluded from the primary comparison.

## CPU and latency results

`cpu-02` qualifies all 48 windows: 240 warmup and 960 timed offers, all successful. Saved wire was rechecked for all 1,200 requests, native readback for all 48 windows, and B upstream-TTFT coverage for all 600 B invocations. Supervisor exit 0 with complete owned-group cleanup. Failed `cpu-01` offers are excluded from this new complete run, not silently removed from their original population.

| Cell | CPU ms/request B / R | B CPU reduction | EOF p50 ms B / R | EOF p95 ms B / R | CPU pairs B lower |
| --- | ---: | ---: | ---: | ---: | ---: |
| JSON, diagnostics off | 10.69 / 11.63 | 8.1% | 33.08 / 36.47 | 43.90 / 46.10 | 5/6 |
| SSE, diagnostics off | 9.75 / 12.24 | 20.3% | 31.76 / 35.04 | 40.90 / 45.57 | 6/6 |
| JSON containers, full diagnostics | 19.55 / 23.18 | 15.7% | 53.47 / 56.97 | 80.27 / 87.97 | 4/6 |
| SSE, full diagnostics | 20.76 / 25.33 | 18.1% | 55.29 / 59.97 | 87.34 / 90.08 | 5/6 |

CPU reductions describe totals divided by all 120 timed offers per arm/cell. They are not a statistical confidence bound. Paired B/R CPU ratios vary: common JSON 0.75–1.61 (median 0.86), common SSE 0.41–0.95 (median 0.86), full JSON 0.68–1.16 (median 0.78), full SSE 0.64–1.09 (median 0.81). Opposite-direction windows remain in the result. The evidence supports lower aggregate cost for these cells, not reliable superiority on every request or deployment.

Both arms consume the same normalized upstream fixture (three JSON data frames plus DONE; only per-request identity differs). Native request serialization is not byte-identical. R still emits its ordinary affinity carrier: common JSON downstream p50 is 629 bytes versus B 311; common SSE is 1,437 versus 749 bytes and five versus three data events. Full diagnostics additionally preserve different physical records. These are complete-behavior comparisons; the CPU difference cannot be attributed solely to encryption or used to price the missing Responses provenance feature.

## Sampled-RSS results

`memory-03` qualifies all twelve windows: three alternating B/R pairs for each common JSON/SSE cell, 60 warmup and 240 timed requests, all successful. The supervisor exited 0 with complete cleanup. Independent raw-sample, request/storage, process-identity, endpoint and cleanup review passed with no blocking findings (`memory-03-independent-review.json`). Neither failed memory attempt contributes samples or requests to this fresh complete comparison.

Each value below summarizes three window maxima of whole-workerd RSS, in MiB (1,048,576 bytes). Parentheses give the observed range; paired differences match B and R within each block.

| Cell | B median (range), MiB | R median (range), MiB | Paired R minus B median (range), MiB | Pairs B lower |
| --- | ---: | ---: | ---: | ---: |
| JSON, diagnostics off | 154.47 (151.88–155.92) | 188.27 (187.30–189.88) | 33.95 (33.80–35.42) | 3/3 |
| SSE, diagnostics off | 154.14 (153.83–155.36) | 188.69 (188.08–189.33) | 34.25 (33.33–35.19) | 3/3 |

The actual cadence is materially coarser than the requested 20 ms. There are 100 independent samples inside the measured intervals, 7–11 per window. Across the twelve covering intervals, 112 adjacent independent-sample gaps have minimum 21.37 ms, median 115.17 ms, mean 106.98 ms and maximum 177.25 ms. Each covering interval runs from the last sample at or before `processStart` through the first at or after `processEnd`; endpoint probes are not inserted into this cadence calculation. Per-window maximum gaps range from 166.86 to 177.25 ms, below the 250 ms qualification bound. Full-lifecycle samples also include warmup and post-interval activity and are not substituted for this cadence.

The maximum includes in-window samples plus the two measured boundary probes. In all twelve windows, its value equals the end probe's RSS; this does not establish when the true peak occurred. Every reported maximum is a lower bound on that window's true whole-process peak. It is neither isolate heap usage nor an acceptance test for the CFW 128 MiB limit. Sparse sampling, three pairs per cell, fixed process overhead and the native output differences above limit interpretation: B has lower observed maxima in this local workload, but neither the true peak difference nor a production memory saving is established. CPU and latency from the sampler runs remain excluded from the primary comparison.

The successful run adds an explicit after-boundary barrier: while the owned workerd is still alive, the coordinator waits for an independent sample at or after `processEnd` and saves its PID/start identity, JSONL line and hash. This proves endpoint coverage without relying on a fixed sleep or relaxing cadence and identity checks. The sample after the boundary qualifies coverage only; it does not extend the measured interval or enter its maximum.

## Tooling verification

Final retained verification logs record 92 passing Bun tests with 325 assertions and zero failures, eight passing Python tests, TypeScript exit 0, and lint with zero errors and two warnings. The logs are `tests-final-05.log`, `python-tests-final-02.log`, `typecheck-final-04.log` and `lint-final-03.log` under the evidence root. These are harness checks; the correctness and resource findings above retain their separate runtime qualification. The final staged check removed one extra EOF blank line, preserving its measured bytes and recording snapshot 06; CPU/memory remain bound to snapshots 03/05. Independent final review, all 52 protected-file hashes and local fast-forward integration passed. Raw evidence and the existing worktree remain local and retained.

## Retained unsuccessful attempts

- `freeze-01`: source verifier confused a symlink identity with its target; rejected output retained. `freeze-02` fixes the tool and freezes the real inputs.
- `canary-01`: raw evidence exposed several oracle assumptions that differed from native contracts. After correcting the oracle, a new complete `canary-02` retained the real failures above.
- `cpu-01`: four windows completed; the fifth finished 25 successful requests but failed native capture qualification. Historical capture logic inferred upstream streaming from the downstream flag; this is invalid for B's new SSE-to-JSON path. Total observed offers are 25 warmup and 100 timed, with 100 timed successes. The run remains unqualified, including all missing windows; it is not included in performance summaries. The versioned readback adapter used by the fresh complete `cpu-02` run verifies source format, full fixture bytes and actual capture termination without changing historical evidence or frozen product bytes.
- `memory-01`: sampler discovery called `proc_pid_rusage` on an auxiliary process before filtering by the workerd executable name. The call failed with `Operation not permitted`, and the sampler exited before producing a workerd sample (`sampleCount:0`, `workerd:null`). The failure surfaced as `Memory sampler process cleanup did not qualify`; the aggregate retains all twelve declared windows as unqualified or missing. The original sampler stderr, JSONL and aggregate are retained. This establishes a sampler discovery error, not unavailable workerd RSS access, a product memory failure or a measured peak. The corrected sampler filters with `proc_pidpath` before sampling and still verifies executable name and process-group ownership after sampling.
- `memory-02`: the first window completed all 25 requests successfully, produced 20 workerd samples and cleaned up, but the last independent sample preceded `processEnd` by 33.837125 ms. Without a sample at or after the endpoint, coverage failed and the complete twelve-window population remains unqualified. The original evidence is retained. The explicit after-boundary barrier above corrects this observer gap in the fresh complete `memory-03` run; it does not repair or splice the failed run's samples into that result.

## Follow-up priorities

1. **Cancellation and resource release:** trace downstream close, `Request.signal`, stream body cancellation, renderer disconnect and turn abort on local workerd. Require upstream close and settled owned work before the fixture cleanup gate opens. Avoid draining an abandoned stream as a substitute for cancellation.
2. **Responses execution provenance:** define and implement ordered source inheritance for state without its own opaque blob. Preserve lazy Chat behavior, native bytes, authorization, compatibility, synthetic-item authentication and rollback readers. The current capability probe becomes a before/after acceptance contract, not a silently relabeled success.
3. **Nonstandard MIME compatibility:** distinguish JSON from SSE using bounded inspection when a provider ignores streaming and omits/mislabels JSON MIME. Preserve early delivery and cancellation; do not buffer arbitrary streams to guess their format.
4. **Release evidence:** once behavior changes, rerun the impacted workerd contracts and a matched resource comparison. Production CFW latency, billing CPU, concurrent isolation and actual memory-limit behavior remain outside this local study.
