# Matched SSE workerd measurement and correctness

Status: `cpu-02` CPU/latency and `memory-03` sampled-RSS comparisons are complete and independently qualified; failed `memory-01` and `memory-02` evidence remains separate. Final tooling verification and local `vNext` integration of study commit `e3b7284a` are complete; nothing was pushed or deployed. The selected correctness population is complete, with three retained failures and no release-readiness claim. [Results and evidence boundaries](../research/2026-10-08-matched-sse-workerd/results.md).

## Scope and constraints

Compare committed vNext `963305f85654ff9b4fac28132739ec7ec9902e9a` (B) with reference `1d7dcd923e260e425120cca0c7a240e93720af27` (R), after the affinity/streaming adoption. Both receive the same downstream offered workload and the same upstream SSE fixture. This is a bounded local experiment, not CFW deployment qualification or a universal performance ranking.

Use the existing resource-fix worktree and installed dependencies. Preserve all unrelated dirty files, historical evidence, active services and production data. Do not install, push or deploy. Local vNext integration is already authorized.

## Execution checklist

- [x] Freeze a clean B commit archive, verify the R archive against its commit, build both real Workers and record exact input identities.
- [x] Implement and verify a new versioned two-arm coordinator and raw-wire/native-storage qualification. Reuse the existing runtime and process ownership machinery without changing historical experiment contracts.
- [x] Run real-workerd correctness canaries: common text/usage/tools and opaque continuation; separately label JSON fallback and failure/cancellation contracts that differ between projects.
- [x] Run CPU/latency after the common workload qualified: `cpu-02` completed all 48 windows, 240 warmup and 960 timed offers, all successful. All upstream dispatches request SSE. Retain the rejected `cpu-01` population separately. Broader correctness failures remain open release gaps and cannot be hidden by the workload gate.
- [x] Independently audit `cpu-02`: re-read all 1,200 request wires, all 48 native storage windows, process/cleanup evidence and all 600 B upstream-TTFT samples. Record the four-cell results and complete-behavior comparison boundaries.
- [x] Complete the separate `memory-03` run: all twelve windows, 60 warmup and 240 timed requests qualify, with supervisor exit 0 and complete cleanup. Preserve failed `memory-01` and `memory-02` without combining their samples. Sampled whole-workerd maxima are lower bounds, not isolate heap or CFW memory-limit measurements.
- [x] Independently re-read the complete memory population, raw samples, identities, cadence, endpoints, native request/storage contracts and cleanup. `memory-03-independent-review.json` records `passed:true` and no blocking findings. Record three-window RSS medians/ranges and paired comparisons; actual covering-sample gaps have median 115.17 ms and maximum 177.25 ms, with 7–11 in-window samples per window.
- [x] Verify final tooling: 92 Bun tests and 325 assertions pass; eight Python tests pass; TypeScript exits 0; lint reports zero errors and two warnings. Retain the final logs under the evidence root.
- [x] Preserve final evidence hashes, commit the measurement/tooling/docs and integrate into local vNext (`e3b7284a`). Final review passed; 52 protected files remain unchanged. Retain the worktree and raw evidence; no push or deployment.

## Measurement contract

The four cells are `json-string-common`, `sse-string-common`, `json-containers-full`, and `sse-string-full`, each with a 64 KiB downstream request. Common cells disable diagnostic dumps and retained history. Full cells preserve each product's own diagnostic guarantees; they are complete-product comparisons rather than identical physical writes. Both arms use the same Miniflare/workerd, compatibility flags, outbound bridge and settlement wrapper, with source instrumentation disabled. CPU covers the owned workerd process through settlement. Warmup is excluded from timing but included in correctness/storage accounting.

Matching upstream SSE means matching delivered fixture bytes, shape and successful completion; serialized provider request field order need not match. Ordinary R affinity output is allowed by its native contract. B JSON fallback and ordinary-output lazy affinity are B-specific assertions. Upstream TTFT is checked against B's native metric contract rather than compared with a nonexistent R metric.

Correctness canaries are separate from performance windows. Do not score a failed request as a fast success. Report exploratory latency distributions and paired CPU results without inferring production billing, exact peak memory, broad concurrency behavior or real upstream compatibility.

## Design rulings

- Reuse the old runtime/seed/readback modules, not the old three-arm frozen plan or aggregate: the old B used upstream JSON for downstream JSON requests.
- Keep the old manifest shape only as an internal adapter for existing runtime functions. A new input receipt identifies current B/R and is authoritative for this experiment; no old population or baseline is included in the new result.
- Reuse generated assets with recorded hashes if absent from the commit archive; UI bytes are explicit build inputs, and UI routes are outside this workload.
- Measure sampled RSS in independent windows so the sampler does not perturb primary CPU/latency results.
- The first correctness run identified native-contract oracle mistakes and two product limitations: untyped JSON for SSE clients, and upstream closure after downstream cancellation. Correct the oracle against raw wire, retain the product failures, and measure the unchanged frozen product only if the standard-MIME common workload qualifies. This study discovers gaps; it does not certify release readiness or silently change the candidate mid-comparison.
- RSS sampling requests 20 ms intervals; measured host scheduling is much coarser. The qualified run contains 100 in-window samples; its 112 adjacent covering-sample gaps range from 21.37 to 177.25 ms (median 115.17 ms). Require endpoint coverage and reject gaps exceeding 250 ms. Do not label the result an exact peak or infer the CFW 128 MiB limit from whole-workerd RSS.

- CPU attempt `cpu-01` remains rejected: the historical sidecar oracle inferred upstream streaming from the downstream `row.stream`. B now requests upstream SSE for JSON clients. The fresh complete `cpu-02` run qualifies with a versioned adapter that validates actual upstream dispatch/MIME/terminal bytes and retains complete native capture checks. Historical oracle, frozen product bytes and rejected evidence remain unchanged.
- Memory attempt `memory-01` remains rejected: sampler discovery queried `proc_pid_rusage` for an auxiliary process before filtering by the workerd name, received `Operation not permitted`, and stopped with `sampleCount:0` and `workerd:null`. This does not demonstrate a workerd RSS permission failure or product memory regression. The new sampler checks `proc_pidpath` before sampling and revalidates executable name and process-group ownership afterward.
- Memory attempt `memory-02` remains rejected: its first 25 requests succeeded and 20 samples were recorded, but the last sample preceded `processEnd` by 33.837125 ms, leaving endpoint coverage unqualified. Preserve both failed attempts unchanged. The fresh complete `memory-03` adds an explicit barrier that keeps workerd alive until an independent sample covers `processEnd`, recording identity, line and hash. This preserves the measured interval and strict endpoint/cadence checks; the after-boundary sample proves coverage without extending the reported maximum.
- Ordinary Chat carriers without a natural opaque value do not prefer the previous target, so their presence establishes no stickiness or cache-hit benefit. Responses uses an additional ordered provenance anchor: later blob-less state inherits an authenticated origin before the synthetic prefix is removed. The JSON/SSE capability probes demonstrate that B lacks this inheritance contract; their expected-behavior passes do not establish equivalence. Keep this capability question separate from the ordinary Chat resource comparison.
