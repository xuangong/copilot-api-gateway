# Diagnostic capacity and ownership contract audit

Date: 2026-10-01. Read-only source/design audit; no test, benchmark, service, remote, source, index, or deployment mutation was performed. This file is the only artifact written by this audit.

## Artifact and scope

- **F** = `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`, verified HEAD `f6797d50a797a2633d60128593861349038f0300`. The existing 14-file Responses/collaboration overlay was present and was not modified. Source anchors below describe the files as read, before any subsequent parent implementation.
- **R** = `/Volumes/Projects/copilot-gateway`, verified twice at clean HEAD `1d7dcd923e260e425120cca0c7a240e93720af27`. It is a design reference, not a dependency or a proven resource baseline.
- Unless prefixed `R:`, paths are relative to F. This audit verifies source ownership and API guarantees. It does not establish workload prevalence, measured retained heap, production saturation, or a CPU/memory improvement.

## Decision

Two narrow improvements can strengthen the existing contract without selecting new numeric limits or an overflow policy:

1. Encapsulate `DumpCaptureBudget` accounting and separate payload admission from owner retirement.
2. Make the in-process broker's channel map own only channels with live subscriptions; publishing to an unobserved channel must not create a retained empty channel.

Neither change closes aggregate publication admission or slow-subscriber queue bounds. Those require distinct product-visible capacity decisions. Do not represent either narrow change as whole-isolate memory protection.

## Existing enforced limits and owners

| Resource | Verified source contract | Ownership/lifetime and exclusions |
| --- | --- | --- |
| Diagnostic payload estimate | `vnext/packages/gateway/src/shared/dump/capture-budget.ts:3-8,74-93`: 4 MiB per capture, 16 MiB per environment, 8,192 frames; constructor accepts only safe nonnegative values at or below the current constants. | Immediate admission, no wait queue. Estimates are not a V8 heap bound. Initial request charge is `backingBuffer.byteLength * 3 + 256` before preparation (`accumulator.ts:181-190`). |
| JSON projection traversal | `capture-budget.ts:15-69`: 65,536 visited nodes and depth 64, UTF-16 and container estimates; private JSON projection before retention. | Stops on the available reservation; does not invoke accessors/custom serializers. Unsupported or excessive capture gets an explicit omission. |
| Capture release | `capture-budget.ts:137-148`; `accumulator.ts:213-214,332-360,496-498`. | Release is idempotent and occurs after terminal work plus the normalized preparation-settled promise. Cancellation/abandonment must not retire started preparation or persistence early. |
| Upstream sidecar | `vnext/packages/gateway/src/shared/dump/upstream-attempts.ts:7-14`: 8 attempts, 64 KiB request prefix, 256 KiB response prefix, 1 MiB body total, 16 KiB headers per attempt, 64 KiB metadata. | Request-local, separate from the capture budget. Borrowed collectors retain their separate ownership; not an isolate aggregate limit. |
| Compression/upload ordering | `vnext/packages/gateway/src/repo/dump-store.ts:209-227,240-272`. | Compression is serial within each write. Up to three sibling body uploads start together and all settle; each completed sibling drops its private byte slot. This is not a cross-write concurrency cap. |
| List/snapshot cardinality | `vnext/packages/gateway/src/control-plane/dump/routes.ts:21-22,65-74,108-127`. | List default 100/max 200, initial SSE snapshot 100. Limits do not bound the later live queue, UI lifetime retention, SQL work, or details. |
| Physical cleanup per pass | `vnext/packages/gateway/src/repo/dump-maintenance.ts:5-8,20-32,36-59`; `shared/dump/spilled-files-policy.ts:8-9`. | 16 keys, 25 records/key, 100 file candidates; 5-minute claim TTL, one-hour staged-file grace. Cleanup work limits are not stored-capacity/admission limits. |

Capture omission preserves metadata persistence: `accumulator.ts:194-204,531-560` and `shared/dump/types.ts:44-66`. Retention `null` disables capture; zero still opens it (`accumulator.ts:604-617`). Keep that existing distinction. The omission metadata belongs to an existing diagnostic row and cannot describe an admission failure that prevents the row itself from existing.

## Verified capacity gaps

### 1. Public accounting API has more authority than its callers need

`capture-budget.ts:87-93` exposes public `reserve(bytes)` and `release(bytes)`. The first checks only `bytes > availableBytes`; the latter directly subtracts. Therefore legal TypeScript calls with negative or `NaN` values can corrupt the accounting invariant. For example, `reserve(NaN)` makes the counter `NaN`, after which comparisons against remaining capacity no longer reject. `release` can subtract capacity that the caller never owned. This is a static API finding, not an observed production misuse.

`DumpCaptureReservation` is also an exported constructible class (`:96-102`), and the same object exposes payload admission and immediate release (`:106-141`). The supported accumulator passes validated requests through `bytes` and normally releases via `retireDumpCapture`; direct budget mutation and direct construction are not necessary to that flow.

Whole-vNext TypeScript inventory:

- `DumpCaptureBudget` production construction: `shared/dump/registry.ts:8,34`; registry exposes it at `:10`.
- Production `budget.open()`: `shared/dump/accumulator.ts:182`.
- Raw budget `reserve` and `release` calls: only inside `capture-budget.ts:112,140`.
- Reservation construction: only `capture-budget.ts:87`.
- Reservation production import: type-only in `accumulator.ts:21,162`.
- `retireDumpCapture` production call: only `accumulator.ts:213-214`.
- Unit tests directly release reservations in `tests/dump-capture-budget.test.ts:12-13,42,63,82`. SQLite ownership tests inspect read-only `retainedBytes`; they do not need raw account mutation.

Smallest contract correction:

- Keep the public budget factory/opening surface and read-only accounting needed for verification.
- Keep raw counter mutation and the reservation implementation module-private; do not export a publicly constructible implementation merely to export its type.
- Return a payload-admission capability (`bytes`, `project`, `frame`, current omission status) separately from the accumulator owner's retirement capability. Payload capture code must not receive arbitrary counter mutation or immediate release.
- Capture the real preparation-settled receipt once at the owner boundary. Retirement must keep the existing terminal-work result/exception behavior and wait for already-started preparation; do not accept an arbitrary numeric release request.
- Keep idempotent release, first-terminal ownership, cancellation/abandonment behavior, graph semantics, all constants, omission labels, and store/broker ordering unchanged.

This is a capability/encapsulation improvement. Merely adding numeric checks to public `reserve/release` leaves arbitrary early release and fabricated ownership available. Conversely, a new generalized scheduler or publication limit is unnecessary for this correction.

### 2. Empty channel entries persist for the broker lifetime

`vnext/packages/gateway/src/shared/runtime/event-target-channel-broker.ts:7-21` stores `Map<string, EventTarget>` entries in `targetFor`, and `publish` calls `targetFor` even with no subscriptions. Successful dump writes publish unconditionally (`shared/dump/accumulator.ts:108-119`), so one entry is created for every distinct published key even if nobody ever opened the dashboard.

Only `closeChannel` removes the map entry (`event-target-channel-broker.ts:24-28`). Subscription `detach` removes listeners but not its channel entry (`:77-80`); `return` similarly leaves it (`:94-99`). Whole-vNext source search finds `notifyDisabledBestEffort` only at its definition in `shared/dump/registry.ts:39-44`, not at an application call site. Its internal `closeChannel` call therefore does not provide routine cleanup. The empty entries are rooted until explicit close or broker/isolate destruction. This is unbounded in historical distinct channel IDs, not a claim that each entry retains past payloads.

**Exact application scope:** `vnext/packages/gateway/src/bootstrap.ts:29-31` creates this same broker for both hosts; Bun calls it in `vnext/apps/platform-bun/src/bootstrap.ts:54-56`, Cloudflare in `vnext/apps/platform-cloudflare/src/bootstrap.ts:70-74`. Gateway bootstrap `:19-22` explicitly documents one broker per Bun process/CFW isolate. No other production `ChannelBroker` implementation or composition was found in F.

Smallest lifecycle correction:

- The map contains entries only while at least one subscription remains attached.
- `subscribe` acquires one entry/reference eagerly, before returning its iterable, preserving publish-before-first-`next()` behavior.
- `publish` may dispatch to an existing entry but must not create an unobserved one. There is no broker replay today; later subscribers already depend on the store snapshot, so no past notification is lost by omitting the empty target.
- Each subscription's abort, channel close, or iterator return releases its entry exactly once. Delete only if the map still contains the same entry and its active count is zero; stale cleanup must not remove a replacement entry.
- An already-aborted subscription should return a completed iterable without creating an entry or attaching listeners. Current code only adds an abort listener (`:83-85`), so an already-aborted signal otherwise has no future event to retire it. Current dump route creates a fresh controller, but the generic API accepts an already-aborted signal.
- Keep cross-channel isolation, active fan-out, FIFO notifications and existing draining/close behavior. Do not add a queue limit, silently drop queued metadata, or broaden this into concurrent `next()` semantics in the same change.
- Preserve codec invocation/rejection semantics if claiming behavior preservation: current `publish` calls `codec.encode` even with no listener. A simple no-entry early return would skip that observable work/error. The actual `dumpCodec` is JSON encode/decode (`shared/dump/codec.ts:11-19`); encode once and avoid target creation, or explicitly document a separate codec contract decision.

The existing broker tests describe eager registration, FIFO, abort, close, return and channel isolation (`tests/event-target-channel-broker.test.ts:28-124`). They were read but not run. A future implementation should verify resource cleanup through a narrow observable owner statistic or equivalent targeted instrumentation, without exposing arbitrary map mutation.

### 3. Each active subscriber has an unbounded metadata queue

`event-target-channel-broker.ts:46-57` retains an unbounded `T[]`; publication decodes a distinct payload for every subscriber (`:60-63`). `publish(): Promise<void>` resolves after synchronous event dispatch (`:20-22`), not after subscriber consumption. `ChannelBroker` has no receipt, backlog, bound or reconciliation surface (`channel-broker-contract.ts:9-12`).

The route subscribes before awaiting SQL snapshot and then awaits each SSE write before calling the iterator again (`control-plane/dump/routes.ts:108-127`). Events can therefore queue during the snapshot read and while the client is slower than publication. Awaiting `writeSSE` does not propagate backpressure to synchronous broker publication. This is a direct source result; the underlying Hono/native transport's exact buffering was not measured here.

The dashboard has a second, separate unbounded retention domain: `mergeRecords` builds and sorts the union of all prior/incoming records, and every live event merges into it (`vnext/apps/dashboard/src/state/dumps.ts:9-14,76-98`). Only key change/unmount resets this state (`:61-72,100-110`). The 25-row page size and 100-row server snapshot do not bound this history. Reconnect merges the latest snapshot; it does not certify recovery of every notification missed during a long gap.

### 4. Aggregate metadata/publication work has no admission owner

Every enabled request gets an accumulator (`accumulator.ts:604-617`), including requests whose payload reservation fails. Omission drops bodies but still builds metadata and directly runs `put().then(publish)` (`:108-119,194-204,531-581`). The budget explicitly excludes metadata/publication slots (`capture-budget.ts:72-73`); `Budget.open()` itself never rejects an accumulator (`:87`).

`BackgroundExecutor` accepts an already-started promise, with no admission API (`vnext/packages/platform/src/background.ts:4-6,35-36`). It keeps ownership/lifetime; it is not a scheduler that limits starts. Serial compression within one `FileDumpStore.put` does not serialize different requests (`repo/dump-store.ts:209-227,390-391`). No cross-request metadata, compression or upload concurrency limit was found on this path.

Headers and metadata strings are also outside capture bytes (`accumulator.ts:75-81,173-179,540-560`). Header/path ownership must be accounted separately if a later publication permit claims a retained-byte bound. A count-only limit cannot establish a byte bound; a payload-only limit cannot establish a task-count bound.

### 5. Readback/export is a separate unbounded representation path

`FileDumpStore.get` loads and decompresses entire objects (`repo/dump-store.ts:373-377,426-488`); event objects are fully decoded and parsed. Full detail then projects wire bodies (`control-plane/dump/routes.ts:76-83`). The export route also calls full `get` before redaction (`:85-100`), and `dumpRecordToExport` clones the whole hydrated record (`shared/dump/export.ts:69-70`) before producing a small redacted representation.

New capture limits do not constrain older stored bodies, decompression expansion, concurrent readers, wire conversion, or this clone. A future bounded preview/read port must be independent of exact full export and must not silently truncate existing detail semantics. Avoid calling the current route a bounded export merely because its final response is redacted.

## Publication admission design to keep open

The next aggregate publication design should distinguish four capabilities rather than extending a boolean capture flag:

1. `CaptureAdmission`: reserves payload representations; exact payload or existing explicit omission.
2. `PublicationAdmission`: admits the operation/metadata ownership before it starts; returns a permit or an explicit rejection receipt, without an implicit waiting queue.
3. `PublicationOwner`: owns preparation, core/optional uploads, SQL visibility and terminal settlement; releases only after all started work actually settles. Cancellation/timeout is not proof that an upload or SQL write stopped.
4. `LiveSubscription`: owns its bounded queued notifications and a typed overflow/reconciliation terminal or state, independently of whether the diagnostic row committed.

For design review, a receipt can distinguish `committed(recordId)`, `notAdmitted(reason)`, and failed/uncertain storage outcomes; do not write one of these receipt variants into inference status. The actual public representation and rejection policy remain undecided. The current `X-Dump-Record-Id` is allocated before best-effort persistence (`accumulator.ts:168-170,483-491`), so it is already a lookup correlation token, not proof of commit. A limit that skips writing creates a new routine missing-record outcome and must specify what HTTP/WS clients and dashboard users see. A metadata-only fallback cannot be the universal escape hatch when metadata capacity itself is exhausted.

No numeric limits or overflow behavior are proposed here. Before enabling this design, choose and document the actual policy from product requirements and exact-artifact evidence: at what phase admission occurs, what representation/task count is bounded, whether rejected requests still have a diagnostic receipt, how retained history reconciles after missed live notifications, and what a full subscriber does. There must be no unbounded waiter list retaining full request records while waiting for a slot.

## Persistence and compatibility obligations

Keep F's ownership progression: snapshot transfer, preparation, file staging, all-started upload settlement, SQL row publication, then notification. `repo/dump-store.ts:275-366` preserves staged-file fences and optional-sidecar fallback; body slot release is independent of later row I/O. SQL must precede broker notification so detail exists for a received event (`accumulator.ts:113-119,563`). Notification failure remains best effort and cannot roll back an already-committed row or trigger inference replay.

The two recommended narrow tasks need no new persisted format, migration, retention default, SSE event name or public inference status. They do not alter borrowed-buffer copies or canonical payload ordering. A future publication rejection or live-overflow event is a separate compatibility change: old clients must not mistake missing notifications for complete history, and old/new reader/writer/GC behavior must be explicitly covered.

## Reference architecture: useful boundaries, no capacity substitute

- R keeps a host-level `ChannelBroker` contract (`R:packages/platform/src/channel-broker.ts:9-12`) and explicit stream-iterator cancellation/pending-read ownership (`:15-68`). Those are useful lifecycle concepts; copying that iterator alone would not bound queues.
- R's Node broker still creates targets on no-subscriber publication and has no last-subscriber map removal (`R:apps/platform-node/src/event-target-channel-broker.ts:7-34,59-68`). It uses `ReadableStream.enqueue` per event without admission (`:83-89`); a high-water mark alone does not stop a push callback from enqueuing. Do not treat R as evidence that this gap is solved.
- R's Cloudflare broker uses execution-cell broadcast and a WebSocket subscription (`R:apps/platform-cloudflare/src/execution-cell-channel-broker.ts:11-28`). It too enqueues each incoming message (`:83-90`). That supplies cross-isolate fan-out, not a demonstrated queue/CPU/memory bound, and adds a platform/service boundary. It is not justified for the two narrow tasks.
- R's capture fully reads request bytes and retains copied response chunks (`R:packages/gateway/src/dump/http-capture.ts:12-26,40-58,74-85`). Keep F's existing demand-driven prefix and aggregate capture safeguards rather than importing R's full retention.
- F's old `src/` tree has no equivalent request-dump subsystem in the read-only `dump|request.?log|capture` inventory; configuration export mentions there are not diagnostic publication precedents.

## Documentation alignment and evidence boundary

`vnext/docs/superpowers/research/2026-09-30-subsystem-contract-refactors/task-6-capture-resource-policy.md:7-29` correctly distinguishes implemented capture accounting from open aggregate metadata/publication admission. Preserve that distinction.

The earlier subsystem design's statement that the canonical frame array has no cumulative cap (`vnext/docs/superpowers/specs/2026-09-30-vnext-subsystem-architecture-design.md:157`) predates the capture-budget implementation and is stale when read as a current source assertion. Its target contracts for live queues/preview (`:165,173`) and invariant that no local cap implies an isolate bound (`:309`) remain applicable.

The reference comparison explicitly keeps diagnostic policy, canonical contents and persistence order (`vnext/docs/superpowers/research/2026-09-30-cfw-resource-remediation/reference-architecture-comparison.md:89-103`). The resource review calls for naming buffer ownership, in-flight work and waiting behavior before adding queues (`architecture-review.md:90`). Those are design constraints, not evidence that aggregate admission has already landed.

CFW CPU/memory tradeoffs are source-level concerns in this audit: per-subscriber JSON decode, per-request compression, overlapping uploads, full readback and metadata tasks remain in the same process/isolate ownership model. No benchmark, cloud metric, current platform-limit lookup or deployment was performed. The repo's dated Cloudflare documentation discussion is historical supporting context (`architecture-review.md:59-63`), not a freshly verified platform or performance claim.
