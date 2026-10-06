# Reference stage measurement harness

This harness implements an A/B observer qualification canary and reference-arm adapters for the [measurement design](../README.md). It does not yet implement or complete the proposed three-arm performance comparison. `completed: true` qualifies the canary only; `comparisonCompleted` remains `false`.

On 2026-10-07, `qualification-ab-03` passed: four instances, eight requests and eight physical dump readbacks, with four owned objects per A instance and six per B instance. Control/probe upstream work checks passed; observed SSE input matched four frames and 683 bytes per streaming request. Exact target/process identity, synchronous clock advancement, heap-field availability and owned-process cleanup also passed. See the [qualification summary](../qualification-summary.json) and [raw evidence index](../evidence-index.json). The result contains no performance conclusion.

## Command and prerequisites

Run from the candidate checkout. The manifest must be an actual, still-valid freeze produced by the [existing A/B harness](../../2026-10-02-workerd-deployed-comparison/harness/README.md), with the intended source, dependency and bundle identities. A commit name or an old result is not a substitute for that freeze.

```sh
bun vnext/docs/superpowers/research/2026-10-07-reference-stage-measurement/harness/run.ts qualify-ab \
  --manifest /absolute/path/to/frozen-manifest.json \
  --out /absolute/path/to/new-output-directory
```

The only command is `qualify-ab`; its only options are `--manifest` and `--out`. The output directory must not exist. Use `run.ts`, not the internal `qualify.ts` entrypoint: the outer runner owns supervision, input revalidation and the final disposition. This command requires macOS, Python 3, the frozen Bun executable and the existing qualified workerd/Miniflare/Wrangler dependency graph. It does not install dependencies.

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

Per-stage deadlines bound builds, readiness, migrations, requests, settlement, readback and disposal. The outer supervisor additionally bounds the entire owned process group to 360 seconds. Failed, interrupted and timed-out runs retain their partial evidence and cannot qualify from a zero exit code alone. There is no automatic retry or pooling of failed attempts into a successful result.

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

The corrected canary serves SSE for requested upstream streaming and JSON otherwise. This qualifies the supported A/B native paths. It does not make JSON-to-JSON and SSE-to-JSON equal work: the reference ordinarily requests upstream SSE even for downstream JSON. The initially proposed all-three-arm SSE-to-JSON common cell therefore requires a supported-path revision before formal collection. A working SSE-to-SSE common path and separately labelled native JSON versus SSE aggregation paths are candidates; their exact contracts and eligibility still need runtime qualification.

## Reference adapter and current blocker

`reference-adapter.ts` builds from the real reference Cloudflare entrypoint using only that source tree's own declared dependencies and precise lock versions. It records consumed input hashes, dependency edges, transformations, migrations and patches in a build receipt. Ambient ancestor packages or vNext packages are not a substitute for missing reference dependencies. Source hooks apply only to product source, not third-party code.

The adapter seeds the reference's native schema and reads its native dump descriptors, usage/performance/history rows and physical compressed objects. It preserves the bootstrap administrator created by the real migrations and allocates a separate fixture user. The reference descriptor schema is not treated as B's upstream-exchange schema, and object counts are not forced equal.

Adapter tests exercised all 86 reference migrations with in-memory SQLite, fixture seeding, file ownership and physical capture readback. That validation is not a real R Worker build or runtime qualification. The recorded build preflight remains incomplete because the isolated reference copy lacks precise dependencies. A single bounded offline install stopped at `ERR_PNPM_NO_OFFLINE_TARBALL`; bounded registry probes connected by TCP but failed TLS with `ENOTCONN`. The source package manifests and lock remained unchanged. No three-arm result exists while R is blocked.

The local recovery/preflight evidence is under `.superpowers/sdd/2026-10-07-reference-stage-measurement/raw/` in the candidate checkout:

- `reference-build-preflight-01/reference-build-receipt.json`
- `reference-dependency-recovery-01.json`

After dependency recovery, R still needs a successful own-root build, its real Cloudflare bindings/exports, observer qualification, physical readback and common-cell semantic qualification. An adapter unit test cannot bypass those gates.

## Durable artifacts and remaining work

| Artifact | Purpose |
| --- | --- |
| `inputs.json` | Manifest identity, executable harness inputs, runtime and scope |
| `supervision.json`, supervisor logs | Owned-process lifetime, exit/timeout/interruption and cleanup evidence |
| `disposition.json`, `result.json` | Initially incomplete/final canary outcome, with `comparisonCompleted: false` |
| `A-approved.json`, `B-approved.json`, per-arm build output | Approved source/dependencies, transformed bundle, source map and build/resolution receipts |
| Per-instance `identity.json` | Bundle/wrapper, Inspector, clock, process identity and hook coverage |
| Per-request `*.offer.json`, `*.wire.json` | Offered request identity and full ingress/client-wire evidence |
| Per-instance `observations.json`, `receipt.json` | Dispatches, traces, settlement, process/heap samples and physical storage readback |
| `A-observer-equivalence.json`, `B-observer-equivalence.json` | Within-arm control/probe upstream work equivalence |

The harness reuses the existing manifest/freezing/resolution, supervision, durable JSON, exact Inspector selection, semantic oracle and physical readback modules. SQL migrations use the installed Wrangler splitter. It does not reuse the old formal runner's workload completion claim: this command is deliberately a smaller qualification driver.

The formal balanced three-arm runner, independent uninstrumented measurement windows, complete work-counter coverage, CPU attribution, size/frame/catalog slopes, memory time series, capacity/load scheduling, slow-reader and cancellation measurements remain unfinished. Run only the stage experiments justified by a qualified common-path comparison. Preserve the distinction between extra guarantees and avoidable implementation work.

This is local synthetic measurement tooling. Canary completion does not authorize or qualify deployment. Catalog/affinity rollback compatibility, backup/restore and other release gates remain separate; no CFW deployment is performed by this harness.
