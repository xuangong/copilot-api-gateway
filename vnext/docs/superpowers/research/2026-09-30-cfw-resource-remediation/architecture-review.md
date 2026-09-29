# Resource architecture review

Scope: the deployed baseline versus the vNext resource repair through `b99b6d6d`, with joint resource acceptance still open. Production has not been updated. This review answers the user's request to assess the architecture as a whole, not only individual hot functions.

## Decision

Keep the protocol/provider/platform separation, canonical turn, request-scoped mutable attempts, authority checks and persistence ownership protocol. Improve how data moves between those layers. Current evidence supports an incremental ownership and lifecycle correction; it does not justify replacing the framework, adding a new service, removing security checks or introducing a generic cache.

| Boundary | Assessment | Action |
| --- | --- | --- |
| HTTP / WebSocket execution | One canonical turn prevents divergent terminal, continuation and cancellation behavior. | Keep one execution path; keep terminal-tail validation and continuation commit before success. |
| Canonical request / mutable attempt | Independent mutable attempts are necessary for retry and interceptor isolation. Repeatedly materializing large immutable strings is unnecessary. | Keep one canonical snapshot, share immutable strings, copy mutable containers only at mutation boundaries. |
| Capture / immutable diagnostic snapshot | Fresh text bytes were copied again; raw pages survived after base64 creation; validation decoded base64 solely to count bytes. | Give internally created buffers an explicit owner, release prior representations after successful conversion, preserve borrowed-byte isolation and exact validation. |
| HTTP delivery / total completion | Early HTTP delivery improves latency but leaves background CPU, buffers and storage waits alive. WS also relies on completion to control admission. | Measure both client delivery and total completion. Do not redefine completion or remove waits without preserving all owners and failure paths. |
| Dump storage | Staging before writes, required files before the row, and the row before publication protect against orphan metadata and late writes. Three serial R2 writes dominate the measured candidate background lifetime. | Keep these dependencies and sequential preparation. A bounded group of three passed correctness review but increased cloud CPU in its pilot; choose scheduling only after joint CPU, memory and completion measurements. |
| Configuration / catalog | Revision leases, pinned views, bounded memoization, single-flight refresh and generation fences already exist. | Preserve invalidation and authority. Measure binding projection at larger catalog sizes before adding another cache. |
| Platform adaptation | Runtime differences belong at capability boundaries. Bun 1.3 and workerd differ in malformed UTF-16 handling. | Use a one-time capability check and a semantics-equivalent fallback, not per-request runtime guessing. |

## What the measurements establish

The original repaired ordinary pilot still used about 57–59 ms CPU versus 9 ms for the deployed baseline. Workerd profiling found per-character closure/name-property allocation in bounded UTF-8 capture. Hoisting that closure reduced the cloud median to about 13 ms; native base64 left a roughly 4 ms residual in subsequent capture-enabled pilots. JSON delivery also serialized twice, independently of whether diagnostic dumps were enabled. These are concrete implementation costs inside otherwise useful abstractions.

Local heap measurements distinguish two effects. After the same 92 requests, the new-minus-old V8 used-heap difference was approximately 10.03 MB with dumps and 10.56 MB without dumps. After snapshots it was approximately 1.91 and 1.87 MB respectively. Thus the temporary JS heap gap cannot be attributed mainly to the new upstream sidecar. In contrast, the backing-storage gap was approximately 5.26 MB with dumps and 0.46 MB without dumps. Capture is a relevant external-buffer cost, but not a complete explanation. These are local Inspector measurements, not production peak-memory bounds or proof of a leak.

Cloud platform wall-time medians in the base64 pilot were approximately 370–416 ms for the baseline and 1061–1086 ms for the candidate, despite similar client completion times. Without dumps the corresponding values were approximately 182–190 ms and 197–200 ms. Normal turn cleanup has no source-level mandatory one-second wait: iterator return is memoized, normal successful terminal observation has reached EOF, and timeout timers are cleared. The dump-sensitive completion difference requires storage-stage timing; a graph resembling a timeout is insufficient to call it a cleanup defect.

The subsequent [isolated R2 timing diagnostic](./resource-timing.json) observed 12 successful requests and 12 exactly-once fixture dispatches. After two warmups, ten requests completed their full registered background work in 926–1132 ms. Three strictly consecutive R2 writes totaled 624–867 ms: mean 733.5 ms out of mean total completion 1026.8 ms, approximately 71.4%. The first upload began at 214–329 ms, and completion followed the last upload by 31–40 ms. This establishes serial storage waiting as a useful optimization target. These are wall-time spans, not CPU measurements; baseline uploads and actual placement were not instrumented simultaneously, so this does not explain the entire A/B regression. The wrapper drains the response and waits for background work and must be removed for formal qualification. An initial urllib attempt returned HTTP 403 without usable timing; the subsequent Bun workload succeeded. Deployment wrapper hashes were recorded before upload; runner hashes were archived after the run.

## Ownership and budget changes

The useful internal progression is mutable capture, immutable snapshot, serialized storage input, then persisted file descriptor. Each transition should have a defined owner and release point. Fresh internal text prefixes can transfer ownership; caller-owned byte views must still be copied. Failed snapshot conversion must remain retryable, and releasing pages must not disrupt a pending upstream read or cancellation.

The existing 1 MiB aggregate raw capture limit is not a whole-request memory limit. Base64, serialized JSON, compression buffers, canonical event history, continuation data and overlapping background jobs have additional costs. Future resource accounting should track bytes and jobs in flight across those phases. A queue that retains many complete records while waiting, or parallel compression of all bodies, could increase peak memory rather than reduce it.

The canonical dump and raw upstream sidecar have different meanings. Removing the sidecar, replacing a captured-empty envelope with null, or silently switching enabled body capture to metadata-only would change the feature contract. None is used as an optimization in this repair.

## Next priorities

1. Finish and qualify the measured duplicate-serialization, native-encoding and owned-prefix changes against the unchanged deployed baseline.
2. Resolve the upload tradeoff before accepting concurrency. The prepared-upload pilot reduced platform wall p50 to 613–634 ms but increased CPU p50 to 15.06–18.06 ms, versus 9.65–10.96 ms in the earlier serial candidate pilot. Memory improvement was inconsistent. These are separate cohorts, so repeat serial and use same-deployment scheduling diagnostics; do not infer a native R2 root cause. Preserve all-started-write settlement, retirement and optional fallback regardless of the final scheduling policy.
3. Continue isolating dump-independent allocations. Current local CPU samples do not establish the source of the entire cloud CPU residual. Do not remove abort, terminal-tail or affinity checks based on an unproven attribution.
4. Add lifecycle and allocation regression workloads to the release process: small and large bodies, JSON/SSE, dumps enabled/disabled, retries, cancellation, background backlog and changing size history. Keep cloud CPU and memory evidence distinct from local sampling.
5. Resume the catalog/affinity rollback work after resource qualification. Any later storage-layout or catalog-cache redesign must include old/new reader and writer compatibility; this performance repair does not introduce such a format change.

Current source anchors: `packages/gateway/src/shared/affinity/analysis.ts`, `shared/dump/upstream-attempts.ts`, `shared/dump/accumulator.ts`, `repo/dump-store.ts`, `repo/configuration-cache.ts`, `data-plane/providers/catalog-coordinator.ts`, and `data-plane/chat-flow/responses/turn.ts`. Paths are relative to `vnext/`. The older general architecture document is useful context but is not treated as proof of current runtime behavior.


## Joint CFW acceptance

The user explicitly requires a balance of response speed, CPU and memory. Optimize redundant work first: incremental rather than repeated full-prefix validation, single serialization, bounded encoding, explicit buffer ownership and prompt release. More concurrency is conditional, not an architectural goal. Shorter wall time is insufficient if it increases CPU, worsens peak memory or creates a background backlog. Conversely, a cache or queue that saves CPU while retaining unbounded request bodies is unacceptable.

Evaluate semantic correctness and exactly-once dispatch first, then paired client p95/TTFE, platform CPU, shared-isolate memory and total background lifetime under the same enabled features. Keep large-body and changed-history workloads alongside ordinary traffic. Platform memory quantiles are shared-isolate observations, not a per-request upper bound. Client delivery and completion are distinct. Existing original gates remain in force; a favorable metric cannot cancel an unexplained regression in another.


The subsequent same-deployment scheduling diagnostic passed 600 semantic and exactly-once checks. Parallel native puts reduced platform wall time in all three pairs; CPU was lower in two and similar in the third. Memory p99 was higher by 1.43 / 4.10 / 2.67 MiB. Bounded overlap therefore stays a provisional candidate, with its costs disclosed; it does not close the ordinary baseline gate. See the [scheduling evidence](./upload-scheduling-diagnostic.json) for the request-level completion barrier and limitations.

`b99b6d6d` also applies the incremental-work principle to affinity reasoning guards. Repeated full-prefix JSON serialization and signature scans are replaced with exact per-fragment budgets; final authenticity/representation checks remain unchanged. This removes a demonstrated quadratic workload for long streams without introducing a request queue or a cache. The ordinary synthetic fixture has no reasoning deltas, so this mechanism cannot explain its existing cloud CPU regression.
