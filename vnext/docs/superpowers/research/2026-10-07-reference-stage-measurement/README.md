# Reference comparison and stage-level resource attribution

Design date: 2026-10-07. Status updated 2026-10-08: all three implementations passed live qualification and a bounded 108-window workerd pilot completed with 2,700 successful requests. See [pilot results and remaining gaps](warm-pilot-results.md). The original 5,400-request proposal, stage CPU attribution, observer overhead, memory peaks and capacity remain unqualified. No product change or deployment occurred.

## Decision and scope

Compare three implementations: deployed-source A, current vNext B and reference R. Match supported source formats and diagnostic settings first, then explain the additional cost of each implementation's complete behavior. The reference is an implementation comparison, not a correctness oracle or an assumed performance target. A faster failing request is not a successful optimization.

The next measurement should identify a stage, a workload dimension and a resource mechanism. Another end-to-end percentage without that decomposition would not answer whether the cost is necessary. Preserve the existing correctness, ownership, diagnostic and continuation contracts while investigating avoidable copies, traversals, stream work and retention.

This report defines the measurement protocol. Execution remains local: no CFW deployment, cloud experiments, production access, changes to existing services, or deletion of evidence/worktrees. The implementation plan permits an isolated reference archive and frozen-lock dependency installation there only, because existing installed dependencies cannot produce a valid R artifact. Existing unrelated changes remain untouched.

## 1. Source identity and what is already known

| Arm | Initial design inspection (October 7) | Qualification boundary at that checkpoint |
| --- | --- | --- |
| A | `e660fb4dfcf1734d10f89e52e2d739b2985c634b`, existing deployed-source tag | Source baseline from the prior experiment; production was not queried today |
| B | Local vNext `dc3824d4b0ae0e66c4719523dfc39195f6d738c0`, with preserved working-tree changes | The previous measured artifact was `cb5ca3b1` plus its recorded overlay/assets. A new comparison must freeze actual inputs again; HEAD alone is insufficient |
| R | `/Volumes/Projects/copilot-gateway`, `1d7dcd923e260e425120cca0c7a240e93720af27`, clean working tree | Source inspected and archived; exact-dependency preflight failed; no runtime result |

The table above records the initial inspection, not the final measurement identity. The [October 8 result](warm-pilot-results.md#identities-and-method) records the actual revalidated A/B product freeze, R compiler inputs and runtime settings.

The [October 3 results](../2026-10-03-owned-preparation/results.md) compare A/B only. They establish ordinary latency, sparse sampled non-idle time, settled heap and correctness/storage observations. They do not establish B/R efficiency, stage costs, concurrent capacity or peak memory. Do not reuse those numbers as measurements of this proposal.

Two current product leads remain configuration defensive copies and adjacent capture/cancellation stream pumps. They are hypotheses to quantify, not established causes of the whole CPU difference.

## 2. Comparability must precede timing

Use all three Cloudflare entrypoints under the same local workerd/Miniflare versions, compatibility settings, machine, fixture service, client and outbound bridge. Use each project's own migrations and persistence codecs, with equivalent synthetic account/model data. Record dependency/build differences rather than forcing a shared implementation into either product. Do not compare reference Bun/Node directly to vNext workerd and label the difference architectural.

Existing `harness/runtime.ts` forwards outbound requests through a host-side `request.arrayBuffer()` and fetch bridge. Reuse the same bridge for every arm and record its work separately. Equal plumbing removes an obvious asymmetry, but body shape and chunking can still interact with its cost. A transport-only control helps diagnose it; do not mechanically subtract the control from product results.

There are two result families:

1. **Common behavior:** match ingress protocol, upstream protocol, output semantics, authentication scope, catalog freshness, actual provider attempts, history reads/writes and diagnostic policy. Use supported configuration only. A dump-disabled cell is an explicitly diagnostic baseline, not a recommended production configuration.
2. **Complete behavior:** run each project's intended configuration and list the guarantees/output/storage it actually provides. Preserve vNext's complete sidecars. Classify additional work as necessary guarantee, additional feature, repeated implementation work or unexplained cost; timing alone cannot decide that classification.

Source-proven differences that require separate cells:

| Difference | Evidence in R (paths relative to the reference root) | Measurement consequence |
| --- | --- | --- |
| Upstream streaming | `packages/provider/src/streaming.ts:21`; custom provider `src/provider.ts:207` | R's ordinary Chat/Responses requests force upstream SSE, including downstream JSON. Use SSE-to-SSE as the common format path. The A canary rejected forced SSE for a JSON request with 502; A/B JSON-to-JSON versus R SSE-to-JSON must retain their different upstream work |
| Diagnostic consumption | `packages/gateway/src/dump/http-capture.ts:12`; `dump/accumulator.ts:229` | R captures upstream exchanges and drains a downstream tee. Compare exact content, cancellation and retained backlog, not just time until its drain completes |
| Retained history | `data-plane/chat/openai-responses/items/store.ts:381` | Retention, ingress origin, `store` and continuation reads affect actual work. Verify observed read/write counts; equal flag names are insufficient |
| Existing TTFT | `data-plane/shared/telemetry/performance.ts:24` | R starts TTFT at provider dispatch and resets it on failover. Its dashboard omits preparation and cannot measure total gateway overhead |
| Failure/cancellation | `data-plane/shared/gateway-ctx.ts:80`; `shared/iterate-candidates.ts:39` | Different abort/fallback behavior can change work performed. Record outcome and dispatch counts before making an efficiency comparison |

Semantic oracles must inspect client output, required continuation, capture fidelity and side effects appropriate to each cell. If an arm fails the target contract, preserve its timing/error evidence but mark the successful-work comparison unqualified. Unsupported cases are `not comparable`, never zero cost. Different physical storage formats get separate readers; do not fabricate identical object counts.

## 3. Boundaries and ownership

Use request and attempt IDs, a stage/operation ID and a clock-domain ID. Record numeric markers and bounded counters without copying request bodies, event payloads, credentials or configuration rows into traces. Count work at existing operation sites; do not add a second traversal or serialization just to calculate a metric. Flush trace data outside the measured work. Diagnostic hooks belong to isolated measurement builds first, not a new always-on production tracing subsystem.

The following are business boundaries, not a requirement to create new services or impose identical call order. Body parsing and authentication order may differ. Record actual nesting and async overlap. Source anchors are initial hook candidates; validate exact placement in the frozen build.

| Stage | Observable start/end | B source anchor, relative to `vnext/` | R source anchor, relative to its root | Work counters |
| --- | --- | --- | --- | --- |
| Ingress and authority | Worker entry; body bytes ready; parsed body; auth/config ready | `packages/gateway/src/app.ts:71`; `repo/configuration-cache.ts:54`; `chat-flow/responses/http.ts` under `gateway/src/data-plane/` | `apps/platform-cloudflare/entry.ts:29`; `gateway/src/middleware/auth.ts:72`; `chat/openai-chat-completions/http.ts:47` under `packages/gateway/src/data-plane/` | Body bytes, parse calls, configuration copies, SQL calls/rows, cache hit/miss/refresh |
| Routing and preparation | Start preparation; candidates enumerated; selected attempt ready | `packages/chat-flow-kit/src/serve-template.ts:247`; `gateway/src/data-plane/chat-flow/shared/select-binding.ts:85`; `gateway/src/shared/affinity/analysis.ts:202` under `packages/` | `packages/gateway/src/data-plane/providers/resolution.ts:188`; `shared/affinity/selection.ts:93`; `shared/iterate-candidates.ts:58` under `data-plane/` | Visible rows, candidates evaluated, containers traversed/copied, carriers, history bytes/materializations |
| Provider preparation | Provider call; actual HTTP fetch invocation | `packages/gateway/src/data-plane/chat-flow/shared/performance-upstream.ts:10`, then the selected provider's final fetch | `data-plane/chat/openai-chat-completions/attempt.ts:31`; `packages/provider-custom/src/provider.ts:204` | Credential/cache operations, serialization bytes, HTTP attempts, dial/adapter preparation |
| Upstream transport | Actual fetch; headers; first semantic frame; terminal; EOF/error/cancel | Final provider fetch and existing raw capture/stream owners | Provider fetch and `data-plane/shared/provider-stream-result.ts:7` | Raw bytes, frames, pulls, attempted/accepted/cancelled dispatches |
| Parse, transform and delivery | Parser/translator operations; matching semantic output; renderer enqueue; downstream EOF/cancel | `packages/gateway/src/data-plane/chat-flow/responses/turn.ts:427`; source adapters and protocol parsers | `data-plane/shared/translate-traverse.ts`; `chat/openai-chat-completions/respond.ts:19`; `shared/sse.ts:90` | Input/output frame counts, bytes, pulls, buffered high-water, backpressure waits |
| Commit, diagnostics and cleanup | Each sink start/end; required history receipt; usage/dump receipt; owner release | `packages/gateway/src/data-plane/chat-flow/responses/turn.ts:342`; `shared/dump/accumulator.ts:334`; `shared/dump/codec.ts` | `data-plane/shared/telemetry/settle.ts:24`; `dump/accumulator.ts:201`; `repo/dump-store.ts:113` | SQL/R2/KV operations, compression input/output, retained bytes, active/pending jobs, release/cleanup outcomes |

In B, `fetchWithPerformance()` includes the provider adapter before actual network dispatch. `PerformanceRecorder.snapshot()` sums attempt wall intervals as `upstreamMs`. Neither `totalMs - upstreamMs` nor time surrounding an awaited stage measures gateway CPU. Keep provider-call and actual-fetch boundaries distinct.

Record client-side offered, first semantic event, terminal, EOF and cancellation using the client clock. Record worker intervals with the worker clock. Do not subtract arbitrary timestamps from different processes. Matching upstream/downstream semantic events must share an identity and a clock domain; a created event and first text delta are not equivalent markers.

Settlement is a separate endpoint, not necessarily a final non-overlapping stage: compression and storage can begin before client EOF, and mandatory history can gate terminal delivery. Record their actual intervals and completion receipts. Report the whole request-to-settlement lifetime and unfinished work after client EOF, without adding overlapping spans into a fictitious total.

## 4. Metrics and their limits

| Question | Metric and measurement | Required interpretation |
| --- | --- | --- |
| How long does the user wait? | Client first-semantic/EOF p50 and p95, worker preparation intervals, and settlement endpoint | Independent latency window without Inspector; no per-frame logging, forced GC or heap snapshots |
| How much CPU is consumed? | OS user/system CPU delta for identified workerd PID over a fixed warmed batch through settlement; report fixture/client/storage processes separately where separable | Local process CPU includes engine/native work and possibly multiple isolates; not isolate CPU or Cloudflare billed CPU. Bun parent CPU is not workerd CPU |
| Which work owns CPU? | Separate V8 sampling window, source-mapped exclusive/self samples grouped by operation, with GC/native/runtime/harness/unattributed buckets | Retain sample count, weights and uncovered time. Async continuations and native work may remain unattributed. Do not multiply a stage's sample share by process CPU and call it exact stage CPU |
| Where does memory grow? | Warm baseline, time series and observed maxima for `usedSize`, `totalSize`, `embedderHeapUsedSize`, `backingStorageSize`; process RSS separately | Inspector maxima are sampled lower bounds on true peaks. Fields have different meanings and must not be naively summed into a CFW memory total |
| How long is memory retained? | Owner-level current/high-water logical bytes and byte-seconds for capture, frames, queues, compression and pending persistence; repeated settled observations | Logical bytes locate ownership but are not heap bytes. Count aliases once within an owner; overlapping owners need an explicit shared-allocation rule |
| What storage is required? | Operations, objects, input/compressed bytes, SQL rows where exposed, sink wait/CPU and backlog | Separate foreground/background work and each sink. Use realistic compressibility; repetitive fixtures do not predict production storage |
| What can it sustain? | Offered load, admitted load, semantic goodput, errors/rejections, queue length, in-flight requests through settlement, resource maxima and drain time | Count all offered requests and missed schedule deadlines; rejection and fast failure cannot improve successful throughput |

For every CPU window report both `total CPU / offered requests` and `total CPU / semantically correct completed requests`, retaining the full numerator including failed work. Include successes, failures, cancellations and background settlement counts. Avoid per-request attribution in concurrent profiles without a mechanism that actually supports it.

Profile distributions and OS CPU are separate observations. The prior harness's `pending.delete` reaction is a known example of instrumentation appearing in the target isolate. Keep harness buckets visible and preserve the raw profile; do not selectively subtract a large sample weight to improve a product result.

Use three separate windows: uninstrumented latency/OS accounting; bounded stage markers/work counters; CPU/heap diagnosis. Validate hooks preserve outcomes, dispatches, pull/cancel behavior and settlement. Compare instrumentation-on/off overhead in a small qualification control, and publish that overhead rather than hiding it. Reject traces that retain payloads or alter demand.

Cloudflare documents that production timers advance only after I/O, whereas local development timers advance during synchronous execution. Validate the chosen local configuration's clock during harness qualification. Local elapsed function time is still not an OS CPU counter. The documented 128 MB limit is per isolate and shared by concurrent requests, not a per-request allowance. No local RSS or heap-field cutoff proves cloud-limit compliance. See [Workers timers](https://developers.cloudflare.com/workers/runtime-apis/performance/), [CPU profiling](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/) and [limits](https://developers.cloudflare.com/workers/platform/limits/#memory). The [CDP Runtime schema](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage) defines the separate heap fields. Official source documents were checked on 2026-10-07; the chosen workerd version must also expose the fields before they are required.

## 5. Small, staged workload matrix

Do not start with a Cartesian product of every protocol, provider, setting and size. Qualify a small common path, then vary one cost driver at a time. Freeze the matrix and stopping rules before the formal run.

### First: common-path attribution

Use native Chat ingress and Chat upstream, one eligible provider/model, warmed fresh catalog, no incoming carriers, no retained history, fixed output semantics and fixed fixture timing. The pilot showed that R always emits an authenticated affinity carrier; diagnostics-off does not establish equal work. Compare:

- Upstream SSE to downstream SSE as the common-format path. For downstream JSON, honor the actual provider request: A/B use JSON-to-JSON; R uses SSE-to-JSON. Keep that cell as a complete-behavior comparison with an explicit source-format difference. Never force SSE on A/B JSON and count its parse failure as a fast result.
- Two 64 KiB request shapes: a long string and many valid messages/tools/small containers. The fixture generator must verify both byte sizes and semantic validity.
- Each arm's complete diagnostics, with actual stored content recorded. Start with these four cells per arm. These are full-behavior comparisons on a common request path, not equal-work comparisons: A lacks the complete upstream sidecar and R has different tee/capture behavior. Preserve and explain those differences. Add a matched supported dump-disabled control for the long-string shape in each mode as the common-behavior diagnostic control, after verifying all other relevant contracts match; this is not a release profile.

For latency, the proposed fixed design is six balanced arm-order blocks (`A-B-R`, `A-R-B`, `B-A-R`, `B-R-A`, `R-A-B`, `R-B-A`), 50 timed requests per arm/cell/block after a fixed recorded warmup. The six cells across three arms would total 5,400 timed latency requests, excluding warmup, pilot and independent diagnostic windows. Report block results and uncertainty; 300 samples per arm/cell do not justify a robust p99 claim. Use equal request counts across arms in independent diagnostic windows. Final counts/deadlines must be recorded in the manifest before execution, with one bounded feasibility pilot kept separate and no favorable-result retries.

### Second: cost slopes at the identified stage

| Change one dimension | Suggested controlled points | What it discriminates |
| --- | --- | --- |
| Input bytes | 4 KiB, 64 KiB, 1 MiB; larger only after capacity controls are qualified | Fixed overhead versus parse/serialization/body retention per MiB |
| Object count at fixed bytes | String-heavy versus many containers | Traversal/copy allocation versus raw byte processing |
| Candidates and visible catalog | 1, 3, 16 candidates; separate model/row sweep | Per-request enumeration, preparation, configuration copying versus shared residency |
| Frame count at fixed semantic output bytes | 16, 256, 4,096 frames | Per-event parser/translation/pump/observation cost versus per-byte cost |
| Diagnostics and compressibility | Supported off/on diagnostic controls; repetitive and high-entropy synthetic text | Capture, compression CPU, object/write amplification |
| Continuation and affinity | Fresh versus valid carried continuation, short versus long history | Verified authority, carrier work, reconstruction and required storage; retain project's own valid carriers |
| Protocol translation | Native path versus one agreed translated pair | Translation work and expansion in canonical events/output |

Suggested points are experimental settings, not supported product limits. Payloads must remain valid. Carrier bytes cannot simply be replayed across implementations with different formats/keys. Align the scenario and verify each implementation's guarantees, then mark non-equivalent guarantees explicitly.

### Third: retention and capacity

Only after valid single-request traces, use one representative large request and a bounded concurrency staircase (initially 1, 2, 4, 8) plus a slow-reader case. Stop at the predeclared host resource guard, product admission/error boundary, unbounded backlog trend or deadline. These values are probe settings, not a promise of supported concurrency.

Use the same load schedule for every arm. Add an open-loop offered-rate sweep below and around the observed capacity knee; record scheduled versus actual arrival so client-side delays do not hide queueing. Track active inference and unfinished settlement separately. Slow consumption must delay the real downstream reader with fixed byte-rate/chunk rules; a provider delay alone does not exercise client backpressure. Add a separately labelled early cancellation case and measure abort-to-upstream-stop, cleanup and retained-byte release.

Cold startup, first catalog load and configuration refresh have their own rows. They are not pooled with warm requests. History-enabled, hosted-search, native WebSocket and queue-saturation cases remain separate qualification work; the small common-path comparison does not close them or the release gate.

## 6. Quantitative diagnosis and decisions

For each comparable cell and stage publish A, B and R values, absolute delta, relative delta where the baseline is nonzero, uncertainty, work counters and unresolved attribution. Compare both B-A and B-R. A reference advantage is a lead to explain, not evidence to copy weaker behavior.

Use explicit growth measurements, such as:

- CPU milliseconds per MiB of input/output, and per 1,000 semantic/input frames, with fixed other dimensions.
- Additional observed heap/backing high-water per additional input MiB or active request, labelled as scenario-specific slopes rather than a universal linear capacity formula.
- Configuration copies and traversed containers per selected attempt; SQL calls/rows per request; upstream attempts per offered request.
- Logical retained byte-seconds and pending work after client EOF, plus drain/cleanup time.

Report the intercept as well as the slope: a warm-cache fixed cost and a body-size-dependent cost need different changes. At least three size/count points are needed before claiming a linear growth trend; nonlinear/threshold behavior stays visible.

Classify conclusions:

1. **Localized:** a repeatable resource delta exceeds the qualification noise/observer envelope, aligns with a stage and work counter, and a controlled dimension change reproduces its growth. Identify remaining native/async attribution. This supports a targeted optimization.
2. **Additional guarantee:** the difference has a demonstrated contract or output/storage difference. Report its measured cost separately from implementation inefficiency; do not silently disable it.
3. **Unresolved:** samples are sparse, clocks incompatible, functionality differs or unexplained/runtime cost dominates. Keep the observation and improve the measurement before attributing it to architecture.

Do not invent a universal acceptable percentage before measuring the noise and capacity envelope. For triage, rank demonstrated avoidable CPU milliseconds and retained memory/time, with resource-limit failures ahead of small median latency gains. A stage's exclusive sample delta can explain part of the sampled delta; parent and child inclusive costs cannot be added. Memory peaks from different times/stages likewise cannot be summed.

The result should be concrete enough to say, for example: a fixed catalog size causes a measured number of extra copies before dispatch; holding output bytes constant exposes per-frame overhead; or a slow reader retains measured bytes until a particular cleanup receipt. These are target statements, not findings already measured.

## 7. Harness reuse and execution checklist

Reuse the [existing harness](../2026-10-02-workerd-deployed-comparison/harness/README.md): frozen source/dependency/assets, exact Inspector target, isolated ports/storage, unique offers and terminal journals, deterministic fixture egress, strict wire checks, physical storage readers, settlement barrier, bounded supervisor and owned-process cleanup.

Required extensions are a reference arm/build/schema/readback adapter, reviewed stage hooks and work counters, workerd PID CPU/RSS accounting, heap/backing time series, matched slow-reader/open-loop scheduling and three-arm aggregation. The current sequential `offer()` loop is concurrency one. Current heap start/settled fields already include backing/embedder values; the missing piece is temporal/peak attribution. Do not describe existing fields as newly discovered measurements.

- [x] Inspect current A/B evidence and source identities; preserve production/no-deployment boundary.
- [x] Inspect R's Cloudflare path, telemetry and non-equivalent contracts.
- [x] Define shared scenarios, stage boundaries, resource ledgers and attribution rules.
- [x] Freeze exact three-arm source/dependency/build/fixture identities and the bounded pilot manifest.
- [x] Implement isolated adapters/hooks and qualify clocks, process ownership and correctness/readback.
- [ ] Qualify warmed observer overhead before interpreting instrumented timing.
- [x] Run the bounded comparison with native-work differences labelled; retain failed/incomplete evidence explicitly.
- [ ] Run only the stage-specific slopes supported by first-pass evidence, then bounded capacity/slow-reader qualification.
- [ ] Publish per-stage results, raw receipts and prioritized fixes; remeasure the selected fixes under the same contracts.

The [implementation plan](../../plans/2026-10-07-reference-stage-measurement.md) tracks individual delivered tools. Three-arm runtime qualification and the uninstrumented pilot are complete. Stage attribution, observer/noise bounds, memory time series and stress milestones remain open; the pilot does not establish causal or release conclusions. Catalog/affinity rollback compatibility and backup/restore remain separate release prerequisites.
