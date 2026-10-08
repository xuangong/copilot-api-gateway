# Reference stage measurement harness

This harness implements A/B/R observer qualification and a bounded warmed three-arm pilot for the [measurement design](../README.md). Canary completion is not a performance result. The pilot has a separate `warmComparisonCompleted` receipt; full profiling, peak memory, retention and capacity remain outside its scope, so `comparisonCompleted` remains `false`.

On 2026-10-07, `qualification-ab-03` passed: four instances, eight requests and eight physical dump readbacks, with four owned objects per A instance and six per B instance. Control/probe upstream work checks passed; observed SSE input matched four frames and 683 bytes per streaming request. Exact target/process identity, synchronous clock advancement, heap-field availability and owned-process cleanup also passed. See the [qualification summary](../qualification-summary.json) and [raw evidence index](../evidence-index.json). The result contains no performance conclusion.

## Command and prerequisites

Run from the candidate checkout. The manifest must be an actual, still-valid freeze produced by the [existing A/B harness](../../2026-10-02-workerd-deployed-comparison/harness/README.md), with the intended source, dependency and bundle identities. A commit name or an old result is not a substitute for that freeze.

```sh
bun vnext/docs/superpowers/research/2026-10-07-reference-stage-measurement/harness/run.ts qualify-ab \
  --manifest /absolute/path/to/frozen-manifest.json \
  --out /absolute/path/to/new-output-directory
```

Available commands are `qualify-ab`, `qualify-reference` and `warm-pilot`. The latter two also require `--reference-root /absolute/path/to/isolated-reference-source`. The output directory must not exist. A coordinator freezes one shared instance context, then launches one fresh Bun child per workerd window. Inner children are non-detached and inherit the outer supervisor's owned process group. Every child must finish disposal and leave no other group member before the next child starts; failure stops the run without retry. Use `run.ts`, not an internal entrypoint: the outer runner owns supervision, input revalidation and the final disposition. These commands require macOS, Python 3, the frozen Bun executable and the qualified workerd/Miniflare/Wrangler dependency graph. They do not install dependencies. R requires its own exact pnpm installation inside the archived source tree.

The manifest loader verifies the executable, source, dependencies, resolution edges and existing artifacts. `inputs.json` additionally freezes this harness's TypeScript, Python, template and JSON files, the reused harness TypeScript files and the manifest bytes. Those inputs are checked again after successful execution. Markdown documentation is outside this executable-input freeze.

## What the canary qualifies

The run starts four isolated workerd instances sequentially: A control, A probe, B control and B probe. Each receives two ordinary 64 KiB string-shaped Chat requests, one downstream SSE and one downstream JSON, with diagnostics enabled. There are eight offers in total, no warmup and no balanced arm-order blocks. These are fresh-instance canary requests; the second request shares its instance with the first.

Controls use the frozen uninstrumented product bundle. Probe bundles apply reviewed source hooks while retaining the frozen dependency identities. Both controls and probes use the same entry wrapper, including the same `waitUntil` registration, failure accounting and settlement barrier. Hooks add bounded request-owned numeric marks and counters through `AsyncLocalStorage`; they do not place request payloads in traces.

Qualification requires:

- Correct JSON/SSE client semantics, terminal evidence and one accepted fixture dispatch per request.
- Control/probe equivalence of the full upstream request byte hash after normalizing only the equal-length benchmark ID, plus request byte count, requested upstream stream flag and response byte count. The dispatch receipt stores the full-body hash and a prefix hash; it does not preserve the complete upstream request text.
- An exact named Inspector target and an owned descendant workerd process, with PID/start-identity checks for resource deltas.
- A local Worker clock that advances during synchronous work, all four required heap fields, and finite monotonic trace timestamps.
- The required ingress, authentication, parsing, routing, provider, HTTP-dispatch and dump-persistence markers; one HTTP dispatch and the expected ingress byte count per trace.
- SSE frame/byte counters matching the fixture's actual stream response, and file-put/compressed-byte counters matching physical object readback.
- Real D1 rows, R2 objects, decompressed content, ownership, wire fidelity and B's upstream sidecar checks through the existing A/B readback adapter.
- Completed background settlement, no observer failures, no unowned trace events, no overflow, and successful owned-process cleanup.

The trace store accepts at most 1,024 requests, 128 marks per request and 64 counter names per request. Counts must be nonnegative safe integers. These are qualification limits, not product capacity limits or a production tracing subsystem. Counter coverage is incomplete; a successful canary does not imply every stage proposed in the design is measured.

Per-stage deadlines bound builds, readiness, migrations, requests, settlement, readback and disposal. Worker readiness has a 60-second deadline outside the measurement window. The outer supervisor additionally bounds canary process groups to 360 seconds and the warmed pilot to 1,200 seconds. Each inner instance additionally has a 120-second deadline. Failed, interrupted and timed-out runs retain their partial evidence and cannot qualify from a zero exit code alone. There is no automatic retry or pooling of failed attempts into a successful result.

## Resource observations and interpretation

| Observation | Actual scope | What it does not establish |
| --- | --- | --- |
| User/system CPU delta | Darwin `libproc` counters for the identified whole workerd process, including Miniflare storage services, through settlement; excludes child CPU | Per-request/stage CPU, isolate CPU, Cloudflare billed CPU, or a warmed performance comparison |
| Process RSS | Instantaneous readings for the same identified workerd process | A memory time series, peak RSS or isolate memory |
| `usedSize`, `totalSize`, `embedderHeapUsedSize`, `backingStorageSize` | Inspector `Runtime.getHeapUsage` readings before requests and after settlement | Peak memory, a heap-object snapshot, a leak result, or compliance with the Cloudflare memory limit |
| Worker marks | Local elapsed timestamps at reviewed boundaries | Exclusive CPU or additive stage totals when work overlaps |
| Client EOF duration | Diagnostic elapsed time with Inspector attached and fixture delays present | Production latency, observer overhead, stable percentiles or an A/B performance ranking |

The process accounting window includes harness settlement but ends before trace export and physical storage readback. The heap readings are point samples, not a `HeapProfiler.takeHeapSnapshot` operation. No forced GC is used. Equal observation plumbing is necessary for qualification but does not make these eight cold offers a meaningful performance experiment. Independent uninstrumented latency/CPU windows and an observer-overhead study remain necessary.

## Upstream format is part of the work contract

The fixture must respect the actual upstream request's `stream` flag. An earlier qualification attempt forced SSE for A's native non-stream request; A returned HTTP 502 with `Unexpected token d` while parsing the response as JSON. Preserve that failed attempt as evidence of an invalid fixture contract, not a product performance result.

The corrected canary serves SSE for requested upstream streaming and JSON otherwise. This qualifies the supported A/B native paths. It does not make JSON-to-JSON and SSE-to-JSON equal work: the reference ordinarily requests upstream SSE even for downstream JSON. The October 8 pilot qualified SSE-to-SSE as the common-source-format path and separately labelled the native JSON versus SSE aggregation paths. Its diagnostics-off control still includes R's additional affinity and framing work.

## Reference artifact and native storage contracts

`reference-adapter.ts` builds from the real reference Cloudflare entrypoint using only that source tree's own declared dependencies and precise lock versions. It records consumed input hashes, dependency edges, transformations, migrations and patches in a build receipt. Ambient ancestor packages or vNext packages are not a substitute for missing reference dependencies. Source hooks apply only to product source, not third-party code.

The adapter seeds the reference's native schema and reads its native dump descriptors, usage/performance/history rows and physical compressed objects. It preserves the bootstrap administrator created by the real migrations and allocates a separate fixture user. The reference descriptor schema is not treated as B's upstream-exchange schema, and object counts are not forced equal.

The October 7 dependency blocker was resolved on October 8 in an isolated archive using pnpm 10.24.0, the unchanged lock, `--prod --ignore-scripts --frozen-lockfile` and a working HTTPS mirror. The original checkout and vNext dependency installation remain unchanged. Build receipts freeze the actual consumed source, dependency, patch and installation metadata. Package module-scope manifests and self-exports retain their native resolution. Two pre-existing undeclared imports are accepted only with proven pnpm private-hoist metadata, physical resolution and ancestry in the importing package's lock closure; they are labelled `undeclared-hoisted`, not declared dependencies.

R seeding uses its native model projector, cache codec and catalog revision, with fresh timestamps, an explicit record-shaped `flag_overrides`, and the native root-origin URL convention. The three seed helper source identities must be present in the same build's frozen inputs. Its 86 migrations, integer user identity and required Cloudflare bindings remain native. The wrapper reexports `ExecutionDO` and `ExecutionOperationEntrypoint` and binds SQLite-backed `EXECUTION_DO`.

The bundled Hono logger contains a dynamic import of the fixed builtin `cloudflare:workers`. All arms therefore use an explicit ES module definition in Miniflare, bypassing its static dependency scanner without changing the module's runtime source. Node and Cloudflare builtins stay native.

`reference-oracle.ts` validates independent client wire, required SQL headers, exact full ingress/raw client/upstream body digests, canonical frames, object ownership, usage/performance counts and disabled history. R's persisted metadata deliberately omits the hydrated `upstream` field; SQL upstream identity and captured exchange identity provide its native linkage. R also does not expose A/B's `x-dump-record-id` response header: its record ID is generated during background persistence. The R oracle derives the native record association from the unique stored `x-benchmark-id` plus complete request bytes/hash, retaining the absent wire header as observed. The oracle authenticates the synthetic native affinity envelope and permits only the source-proven egress transformation: one pre-stop SSE carrier, or the corresponding JSON message field after canonical folding. R stops its upstream SSE reader on `[DONE]`; `capture.complete=false` is accepted only with exact complete raw bytes/hash, a unique final DONE and independently completed fixture dispatch, and is explicitly retained in the receipt. JSON captures still require EOF completion. Failed canaries remain separate evidence; corrected seed/bootstrap assumptions are not product fixes or performance observations.

## Bounded warmed comparison

`warm-pilot` freezes 108 independent windows: six arm-order permutations, six workload cells and three arms. Each window has five warmup requests followed by twenty timed requests (540 warmup and 2,160 timed in total), concurrency one, fresh isolated storage, and no source hooks or Inspector attachment. The manifest is written before the first window. No automatic retries or selected-window reruns are allowed. This host isolation follows two actual canary startup failures (including a broken control pipe), but does not claim a diagnosed Bun or Miniflare bug: 24 minimal startup trials, with and without Inspector and with shared/fresh hosts, did not reproduce it.

The resource sequence is warmup, successful settlement, OS CPU/RSS start sample, timed requests, successful settlement, OS CPU/RSS end sample, then physical readback. Warmup is excluded from timed latency/CPU denominators but included in exact usage, telemetry and physical-storage accounting. All three arms use a positive one-hour diagnostic retention when enabled; NULL disables it. Earlier canaries used numeric zero, which permits physical capture but immediately hides R records from its retention-filtered control-plane reads. They remain failed or cold qualification evidence, not pilot data. Disabled cells must have no dump rows, spilled objects, R2 objects or retained history, while native usage and performance work still completes.

All offers receive terminal receipts. Client elapsed time currently covers request start through full body EOF; there is no first-semantic latency claim. Raw request bytes must equal the exact frozen `makeRequest` result, including the 65,536-byte size and the selected string/container shape. Each timed group has 120 samples across six blocks; report block results and exploratory p50/p95 without robust tail or capacity claims.

CPU is the whole identified workerd process, including local storage services and settlement plumbing. Report CPU per offered and per successful request. RSS is sampled only at window endpoints; it is neither peak memory nor isolate memory. Host-side offer/wire journaling can introduce inter-request idle time; this pilot does not measure throughput or simulate open-loop production traffic.

Only `sse-string-common` is the matched diagnostics-off, common-source-format control. This is still a native-behavior comparison, not an equal-work claim: R always adds an authenticated affinity carrier and splits usage into a separate SSE event, while the frozen A/B fixture outputs do not carry an opaque signature. For the two cold control requests, A/B returned 683 SSE bytes or 289 JSON bytes; R returned 1,327 or 607 bytes with the same visible text and token usage. Pilot response sizes must be taken from its own rows because request IDs differ. Full diagnostics preserve different guarantees. Both JSON cells retain A/B JSON-to-JSON versus R SSE-to-JSON behavior, including `json-string-common`; its name is not an equal-work assertion.

`reaggregateWarmOutput()` verifies all planned windows and rechecks original wire bytes, settlement, process identity, source formats and saved native side-effect evidence. It reruns R's native oracle and A/B's own usage, performance summary, histogram and modern metric checks. It also verifies per-window job/context hashes, inherited-process ownership, successful cleanup and dispatch receipts. It does not reopen a running Worker or claim a new physical R2 read. Missing or invalid artifacts retain incomplete populations and invalidate comparison qualification.

## Durable artifacts and remaining work

| Artifact | Purpose |
| --- | --- |
| `inputs.json` | Manifest identity, executable harness inputs, runtime and scope |
| `supervision.json`, supervisor logs | Owned-process lifetime, exit/timeout/interruption and cleanup evidence |
| `disposition.json`, `result.json` | Initially incomplete/final canary outcome, with `comparisonCompleted: false` |
| `A-approved.json`, `B-approved.json`, per-arm build output | Approved source/dependencies, transformed bundle, source map and build/resolution receipts |
| `instance-context.json`, per-instance `instance-job.json`, `instance-process.json`, `instance-result.json` | Frozen shared host input, exact job identity, inherited process-group cleanup and child completion |
| Per-instance `identity.json` | Bundle/wrapper, Inspector, clock, process identity and hook coverage |
| Per-request `*.offer.json`, `*.terminal.json`, `*.wire.json` | Offered/terminal identities and full ingress/client-wire evidence |
| Per-instance `observations.json`, `receipt.json` | Dispatches, traces, settlement, process/heap samples and physical storage readback |
| `A-observer-equivalence.json`, `B-observer-equivalence.json` | Within-arm control/probe upstream work equivalence |

The harness reuses the existing manifest/freezing/resolution, supervision, durable JSON, exact Inspector selection, semantic oracle and physical readback modules. SQL migrations use the installed Wrangler splitter. It does not reuse the old formal runner's workload completion claim: this command is deliberately a smaller qualification driver.

The 5,400-request formal proposal, warmed observer-overhead qualification, complete work-counter coverage, CPU attribution, size/frame/catalog slopes, memory time series, capacity/load scheduling, slow-reader and cancellation measurements remain unfinished. Run only the stage experiments justified by a qualified common-path comparison. Preserve the distinction between extra guarantees and avoidable implementation work.

This is local synthetic measurement tooling. Canary completion does not authorize or qualify deployment. Catalog/affinity rollback compatibility, backup/restore and other release gates remain separate; no CFW deployment is performed by this harness.
