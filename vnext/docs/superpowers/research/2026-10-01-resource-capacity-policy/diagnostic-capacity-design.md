# Bounded diagnostic live view and reconciliation

Date: 2026-10-01. Design only, based on F at `648a521eaa6c20a4ce937525e01c87093f46c8f4`. No source changes, tests, CI, benchmarks, network access, index operations, or commits. This document is the only artifact written. Numbers below are provisional engineering policy, not measured workload percentiles or a whole-isolate memory guarantee.

## Decision

Implement a bounded, best-effort **latest view**, with explicit overflow and limited reconciliation. Preserve persisted record contents, inference outcomes, storage-before-notification, and the existing full-detail/export APIs. Do not introduce a durable replay cursor, cross-isolate transport, or aggregate diagnostic-publication admission in this increment.

A live notification says that storage succeeded on its publisher; it does not certify that other commits were delivered. Reconciliation refreshes a bounded latest window. It cannot repair arbitrary historical gaps, and must never display “all records recovered.” The bootstrap comment describing cross-isolate reconnect as replay must be corrected accordingly.

## Current source evidence

Paths below are relative to F; read together with `vnext/docs/superpowers/research/2026-10-01-diagnostic-resource-contracts/diagnostic-capacity-audit.md` and the hosted-search execution contract matrix. The earlier audit predates the current broker ownership changes.

- `vnext/packages/gateway/src/shared/runtime/event-target-channel-broker.ts`: live-only channel ownership and cancellation now exist; each subscription still retains an unbounded array of decoded `T`. Codec encode happens once per observed publication, decode once per subscriber. Publication does not await consumption.
- `shared/runtime/channel-broker-contract.ts`: shared sequential iterator, concurrent-pending-next rejection, abort/return discard, and graceful-close FIFO drain are explicit. No publication receipt or recovery cursor exists.
- `shared/dump/broker.ts`, `bootstrap.ts`: the only production specialization found is `ChannelBroker<DumpMetadata>`. Generic tests also use strings and reentrant codecs. Bootstrap creates one broker per Bun process or CFW isolate.
- `control-plane/dump/routes.ts`: ownership/auth checks precede subscription; subscribe precedes list(100); raw abort now reaches snapshot preparation. Writes are awaited sequentially. List default/max is 100/200; no byte limit exists.
- `shared/dump/types.ts`: metadata includes unrestricted path, model, upstream name, and error reason strings. Body-free is not byte-bounded.
- `repo/dump-store.ts:394-425`: SQL orders `created_at DESC, id DESC`, hydrates metadata JSON, and resolves `before` by row lookup. This is a history pagination boundary, not a commit sequence. Deletion/retention can invalidate a cursor; late commits can land behind a previous query boundary.
- `shared/dump/accumulator.ts:108-121`: put resolves before broker publish; notification failure is best effort after persistence. Capture omission still builds and persists a row.
- `vnext/apps/dashboard/src/api/dumps.ts` requests 25 rows per page. `state/dumps.ts` merges every page/snapshot/appended event indefinitely, sorts by completedAt/id, and clears live errors on any valid event. Neither behavior represents recovery completeness.
- `vnext/packages/gateway/tests/event-target-channel-broker.test.ts:11-28` has a small body-free metadata fixture with a normal path and null optional fields. It supports selecting a generous small-record allowance, but gives no evidence about production metadata tails or throughput.

## Provisional policy and cost

| Owner | Proposed default | Reason / qualification |
| --- | --- | --- |
| Each diagnostic subscription | 100 queued items and 256 KiB charged encoded storage, whichever fills first | Aligns with one current snapshot, four UI pages. Count protects many tiny events; bytes protect long metadata. |
| One live metadata frame | 16 KiB charged encoded storage, checked even when a reader is pending | Ordinary fixture fields are far smaller; intentionally long path/error records can exceed this. Oversize causes explicit reconciliation-required, never silent truncation of a persisted record. |
| Charged string representation | `2 * encoded.length + 128` per queue item | Conservative UTF-16 code-unit accounting plus bookkeeping allowance; not measured JS heap. Retain encoded strings, decode only on pull. Measure without allocating a second UTF-8 buffer. |
| Live connections | 4 per key and 16 total per process/isolate | Allows several tabs per key while bounding aggregate fan-out and pending route owners. No waiter queue. Admission failure is HTTP 429 with Retry-After: 5 before snapshot work/SSE headers. |
| Snapshot sent over bounded live endpoint | At most 100 rows, each within frame allowance, total 256 KiB charged representation | Keep newest fitting rows; include omitted-row count and reason in snapshot envelope. No canonical mutation. Source SQL materialization is still excluded from byte guarantee. |
| Browser retained list | 500 rows and 2 MiB charged serialized metadata | Twenty current pages; size checked before insertion. Evict oldest entries visibly. One selected detail remains separate and is not covered by list bound. |
| Reconciliation | Latest 100 rows on reconnect/overflow, plus every 30 seconds while visible and on focus | Process-local broadcasts miss cross-isolate commits even on a healthy connection. One reconciliation request per hook at a time, no overlapping interval work. |
| Retry | 5 seconds initial delay, exponential to 30 seconds with jitter | Prevent repeated overflow/reconnect from becoming immediate query loops. Explicit Refresh may request one retry, never parallel retries. |

At 16 connections, charged waiting strings total at most 4 MiB, plus at most one 16 KiB pulled live frame per connection and up to one 256 KiB snapshot representation per connection. Snapshot output ownership and queued updates can overlap, so the nominal representation allowance is roughly 8.25 MiB, before SQL result graphs, encoding/decode transients, transport buffers, timers, and JS overhead. Do not label that calculation a physical heap ceiling. A blocked route must retain its connection permit; otherwise repeated reconnects can create unbounded writers despite the broker subscription limit.

At 30-second refresh, 16 visible clients add up to 32 latest reads/minute per process/isolate, independent of live event rate. Browser polling is not a server-wide rate limiter, and several isolates or clients multiply this cost. This deliberately trades bounded latest-view staleness for SQL read traffic; qualification must measure that cost before release. No claim is made about CFW platform numeric limits.

## API boundary and compatibility

Do not change `ChannelBroker<T>.subscribe()` into `AsyncIterable<T | Overflow>`: that breaks every generic consumer and lets control events masquerade as application values. Preserve the default generic API and its existing semantics/tests.

Add an explicit bounded subscription capability implemented by the same broker internals, exposed to dump routes through a narrower extended dump-broker interface:

- `subscribeBounded(channel, signal, policy)` returns a handle with an `AsyncIterable<T>`, read-only terminal/state accessor, and cancellation capability. Eager registration remains mandatory.
- State distinguishes active, graceful closed, canceled, and `reconciliation_required` with a closed set of reasons: queue_count, queue_bytes, frame_bytes. The state accessor is required to detect overflow before initial snapshot delivery, without pulling an item.
- Overflow clears pending payload strings, detaches publication listeners, and latches one small terminal reason. A pending or subsequent `next()` rejects with a typed capacity error exactly once, then stays done. It must not allocate a growing drop ledger or rely on throwing from EventTarget callbacks.
- Queue byte checks happen on the shared encoded string before queueing/decoding. Decode only the next selected frame. If codec callbacks reenter cancellation/close, recheck state before delivery. Default unbounded subscriptions preserve existing codec timing; the new bounded capability explicitly documents lazy decode.
- Graceful close still drains admitted FIFO frames, unless abort/return discards them. Overflow is a different terminal outcome and discards the buffered tail. An already-aborted subscription allocates nothing. One shared iterator and pending-read rejection remain intact.
- Subscriber admission belongs to a dump route/session owner with synchronous immediate acquire and idempotent retirement, not a user-visible mutation of the generic channel map. Hold the permit from before subscription/snapshot through all started snapshot/write settlement and cleanup. Subscriber counters represent open route owners, including blocked writers; detached-listener count is a separate statistic.

Use an opt-in stream version, such as `?view=latest-v1`, for new wire semantics. Upgrade bundled dashboard and server together. Legacy endpoint consumers retain old behavior; **legacy streams must not become an unlimited bypass**: apply the same connection and queue limits, but close their stream on overflow and let existing reconnect behavior occur. Document that only latest-v1 clients expose the new reason and explicit limited-recovery UI. Legacy clients never had a lossless guarantee, but will not acquire the new visibility contract automatically.

## Overflow and blocked-writer ordering

There is one SSE writer owner. Never start an overflow write concurrently with a blocked snapshot/appended write.

1. Admit connection, subscribe eagerly, then start SQL latest read. Raw abort immediately cancels subscription; a started SQL read remains observed until settlement.
2. If overflow occurred during SQL read, discard its result after settlement. Do not send an apparently fresh snapshot first. Send one `reconciliation_required` control frame and close (if transport remains writable).
3. If state remains active, build the bounded snapshot envelope, recheck cancellation/overflow immediately before starting its write, then write snapshot. Include `view: latest`, `limit: 100`, and representation-omission information. Do not encode a fake resume cursor in SSE `id`.
4. A write already started cannot be retracted. If overflow occurs while it is blocked, latch the reason and clear queued payloads immediately. After the in-flight write settles successfully, check state before any next append; send the control frame and close. If the write fails/connection aborts, cleanup without attempting another write. The client sees disconnect and reconciles even when no control frame reached it.
5. Check state after every awaited iterator read and immediately before starting appended delivery. A resolved pending read is not authority to deliver after an intervening overflow/abort. One already-started frame may arrive before the control event; none starts after it.
6. The terminal event states `{ reason, recovery: "latest_snapshot", completeHistory: false }`. It must not report a precise dropped count after listener detachment, a lost-record count, or persistence failure. Event omission is distinct from capture omission.

Do not promise a terminal event reaches a permanently blocked client. The bounded queue and detached listener bound this owner's retained notification backlog; the connection permit stays occupied until actual writer/SQL settlement. A later implementation may close transport through a verified cancellation API, but a timer race is not evidence that its writer or SQL operation settled. Under noncooperation, capacity can remain unavailable: fail closed for new diagnostic streams without affecting inference.

## Dashboard latest/history behavior

**Implementation staging:** the first increment must deliver visible overflow, limited latest reconciliation, route permits, and connection-generation guards. The 500-row/2-MiB browser policy and separate history mode below are a concrete follow-up design if they require substantial navigation changes. Do not apply an unconditional slice to the current merged list: it breaks useful older-page navigation. If history restructuring is deferred, explicitly report browser retained history as still unbounded; do not claim this increment bounds all diagnostic memory. Full-detail/export changes remain excluded in either case.

- Display “Live updates are best effort; latest 100 are refreshed” and a last-successful-refresh time. Keep overflow/disconnect or representation-omission status separate from transient network error; an arbitrary appended event must not clear it.
- On overflow, explicitly close EventSource and schedule one bounded reconnect. On ordinary disconnect, treat continuity as unknown as well. Use connection-generation guards to ignore late snapshot/page events from a replaced source.
- Reconcile by **replacing the current latest window**, not merging it into supposedly complete history. Reset its pagination boundary from the returned latest page. Label the result “Latest records refreshed; earlier gaps may remain.” Successful refresh can resolve “refresh pending,” but does not certify history completeness.
- Periodic latest reads require an API limit of 100, since the existing client helper hardcodes 25. Track one in-flight fetch; pause while hidden. On focus refresh once. No repeated full-history scan.
- Keep latest view and manual older-history browsing as explicit modes. In latest mode, apply live updates and bounded retention. Entering older-history mode pauses live insertion (and closes the stream); retain at most 500 rows/2 MiB, with a forward `before` cursor based on the fetched page, not on whichever row eviction leaves last. Once full, loading older pages evicts newer pages and displays a window indicator. Return to Latest resets the window and starts a fresh stream. This avoids an ineffective Load More button that fetches rows only to trim the same rows immediately.
- Apply the same item/byte admission to live, snapshot, and historical-page rows. Oversized metadata is omitted with a visible count and access to existing record lookup/detail where an ID is known; do not retain unbounded omitted-ID arrays. Source JSON parsing and a selected full detail/export remain separately unbounded representations.
- Poll/live races are limited-view races, not solved by timestamps: during one fetch, stage at most 100/256 KiB incoming live records, then replace with its latest snapshot and merge only that bounded stage. Overflow invalidates that refresh and requests another scheduled reconciliation. One staging owner shares the browser list policy; it must not introduce an unlimited auxiliary buffer. A delayed commit older than the latest window may remain absent forever from latest mode.

## Aggregate diagnostic publication admission: separate increment

Keep it explicitly open. Queue limits bound notifications **after** SQL commit. They do not bound concurrently active accumulators, metadata strings/headers, compression, upload work, or background persistence. A notification overflow must never reject a diagnostic write or alter inference status.

Publication admission needs a separate product contract before implementation:

- Acquire an operation permit before retaining the metadata/work it claims to bound; a permit acquired only at final put does not bound earlier capture owners. Admission must return immediately with no full-record waiter queue.
- Return explicit `admitted(owner)` or `notAdmitted(reason)`; terminal receipts distinguish `committed(recordId)`, confirmed failure, and uncertain storage outcome. Keep cancellation separate from real started-work settlement. Release only after preparation, all started uploads and SQL settle.
- Count-only permits are a concurrency bound, not a metadata byte bound. Headers/path/error strings need their own policy. A metadata-only fallback cannot solve metadata saturation.
- `X-Dump-Record-Id` is currently a preallocated lookup token, not commit acknowledgement. A routine new not-admitted outcome needs a distinct public header/WS representation and dashboard receipt behavior. No durable row can be assumed available to store its own admission rejection; an unbounded in-memory rejection registry is not acceptable either.

Do not smuggle this into a queue constructor option or repurpose capture omission/inference errors. The present numeric choices intentionally cover live viewing only; choosing a publication permit number without its admission/receipt surface would be a separate, incomplete behavior change.

## Future implementation acceptance (not executed here)

Cover exact count/byte boundaries, a single oversized pending-reader frame, zero-allocation already-aborted subscription, lazy decode/reentrancy, shared iterator, graceful drain versus overflow discard, and permit saturation without waiter queues. Verify overflow during SQL, before snapshot write, during blocked snapshot/append, and between awaited read and delivery. Hold permits through actual late settlement, and verify disconnect without terminal delivery still initiates limited reconciliation.

Dashboard checks must include a long-running live feed, 500-row/2-MiB history windows, oversized metadata, reconnect generations, paused history navigation, hidden-tab polling, cross-isolate notifications absent despite healthy SSE, and commits that appear behind previously fetched boundaries. None may claim complete recovery. Qualify the per-isolate traffic/retention tradeoff before release; benchmark and deployment remain outside this design task.
