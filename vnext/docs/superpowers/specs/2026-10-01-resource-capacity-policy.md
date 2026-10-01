# Resource capacity and diagnostic latest-view contracts

Date: 2026-10-01. This increment implements the remaining admission points after hosted execution/cancellation contracts. Numeric defaults are provisional engineering policy for local qualification, not measured safe CFW production limits. No deployment is authorized by this specification.

## Architecture

Hosted search has separate owners for operation admission, successful-body ingress, private replay, page-cache retention and Chat-generated continuation. A single safe typed capacity failure crosses ordinary provider error/fallback handlers to the existing protocol error owner. Capacity never becomes a successful error snippet, silent eviction, missing-replay notice or additional model turn. Cancellation and real settlement retain their existing owners.

Diagnostic live delivery is a best-effort recent-record view. Bound notification queues and open route owners; keep persistence authoritative. Overflow terminates live delivery visibly where possible, but cannot guarantee delivery of its own terminal notice. The client can refresh the latest window. Neither reconnect nor refresh proves complete historical recovery; completedAt/id is not a commit-ordered cursor, and the broker remains process/isolate-local.

## Search policies

| Domain | Default | Admission and excess behavior |
| --- | --- | --- |
| Operations | 64 per invocation | Charge before parser expansion, argument slices, slots and start. Share across original calls/reentry/refusal calls; reject the whole offending call. |
| Successful HTTP body | 1 MiB per response | Admit each chunk before copying; parse only admitted complete bodies. |
| Successful ingress | 8 MiB cumulative per invocation | Synchronous monotonic debit shared by concurrent reads, fallback and page helpers; no refund or waiting queue. |
| Owned Responses replay | 64 entries / 4 MiB estimated charge | Atomic admission before insertion/completed frames; failed replacement preserves old entry. |
| Owned page cache | 64 entries / 2 MiB estimated charge | Admit actual key/value graph before successful cache publication; no eviction/refetch. |
| Chat generated continuation | 4 MiB estimated charge | Charge newly added messages and annotations once before retention/reentry; initial input is not repeatedly charged. |

The 64-operation default permits two queries across the existing 30-turn policy plus four other operations. Existing mixed/two-query fixtures remain admitted. A maximum-context result contains up to 40 snippets at 2,048 characters; 1 MiB raw ingress leaves room for provider metadata, but deliberately rejects unusually large bodies. The cumulative limit prevents a 64-by-1-MiB input allowance. Replay/cache estimates allow multiple substantial results and ordinary 10-KiB pages. These are policy tradeoffs, not production distribution measurements; legitimate large workflows can now fail explicitly.

Operation counting matches parser cardinality: supported defined arrays by length, supported defined scalars by one, unsupported arrays by length, unsupported scalars (including undefined) by one, sparse holes included, and a minimum of one per call including null/empty calls. Use early saturation and own-key enumeration without per-array-element inspection. An admission belongs to one scope and one argument object; preparation/refusal consumes it once, without refunds. Refusal must not require parser expansion.

Successful-body reading uses bounded blocks, not one retained array entry per network chunk. Full chunks must fit both limits before copying. Do not retain views into oversized backing buffers. Ignore Content-Length for authority; exact limit requires EOF. A native null body is empty. Release locks and observe cancellation without awaiting a noncooperative cancel as the error decision. Built-in standalone readers enforce per-response limits; hosted requests also carry the shared ingress capability. Provider instances do not own invocation counters. A reader capacity failure latches at the shared invocation scope immediately with the original safe capacity reason, closing sibling fallback/start gates before a later result slot is consumed. Include Tavily search/extract, Jina search/reader, LangSearch, Microsoft grounding search/reader, Bing HTML and Copilot search. Alpha/model streams stay outside this policy.

Retention uses a bounded noncloning estimator: strings and keys `32 + 2 * length`, object 64, array 64 plus 8 per slot, property 16, primitive 8, with 65,536 visited values and depth 64. Inspect own data properties; reject symbol keys, accessors, exotic prototypes, functions and cycles. Preserve JSON-like extension fields. Charge duplicate references conservatively; account for replacement net charge and item IDs. Estimate once per write, never on reads. Trusted retained graphs remain borrowed and must not be mutated after admission. No JSON.stringify/deep clone/freeze to meter retention. Reflection and already-created input graphs, runtime chunks, JSON parsing expansion, external provider/store internals and caller-held history are outside these quantities. These are not isolate heap bounds.

## Diagnostic live policies

| Domain | Default |
| --- | --- |
| Queue per subscription | 100 frames / 256 KiB charged encoded storage |
| Single frame | 16 KiB charged storage, even for a pending reader |
| String charge | `2 * encoded.length + 128` |
| Open stream route owners | 4 per key / 16 total per process/isolate, immediate admission with no wait queue |
| New latest snapshot | Up to 100 rows, per-row frame allowance, total 256 KiB charged storage |

Generic unbounded broker subscribe behavior remains compatible for existing generic uses. Add an explicit bounded capability; production dump streams must all use it so legacy URLs cannot bypass limits. Retain encoded strings and decode on pull only in the bounded path. Preserve eager registration, one shared iterator, single pending read, graceful FIFO drain, and abort/return discard. Overflow clears queued payloads and detaches listeners immediately, latching a small typed reason (`queue_count`, `queue_bytes`, `frame_bytes`). Never throw from EventTarget callbacks or retain a growing drop ledger. Check the gate after awaited reads and codec reentry.

A route permit is acquired after auth and before subscribe/list, and retired only after started SQL and writer work actually settles. Raw abort releases the subscription immediately but does not pretend SQL/writer work settled. Rejected admission returns 429 with Retry-After 5; inference and persistence are unaffected. Preserve subscribe-before-snapshot and the previous cancellation-window fix.

Bundled dashboard opts into `?view=latest-v1`. Snapshot adds `view: "latest"`, `limit: 100`, `omittedRows` and `completeHistory: false`; fit newest rows without mutating canonical metadata. Overflow sends `reconciliation_required` with safe reason, `recovery: "latest_snapshot"`, `completeHistory: false`, then closes. Legacy streams retain original snapshot/appended shapes and close on overflow. No concurrent terminal write: await any already-started write, then check state. Overflow during SQL skips snapshot delivery; permanently blocked transport may never receive the notice. Snapshot SQL materialization and encoding transients remain outside byte claims.

Dashboard first-slice policy deliberately avoids periodic SQL polling and a history navigation redesign. Show persistent best-effort scope and continuity-unknown/overflow status independently of transient errors. On explicit overflow, close EventSource and offer Refresh latest. Refresh cancels superseded list work, resets list/cursor from a new latest snapshot and starts a new generation; stale callbacks cannot mutate the new view. Ordinary disconnection may use existing EventSource reconnection, but must retain the incomplete-history warning. An arbitrary appended event must not clear continuity/omission status. No statement of complete recovery. Existing manual older-page browsing remains available and retained history is explicitly not bounded by this increment.

## Deferred gates

- Aggregate publication admission/receipts, metadata capture concurrency, browser history window, full detail/export/decompression need separate policies. No routine missing-row outcome is introduced here.
- Stabilize the existing local workerd runner before a fresh combined comparison: isolated bounded phases, durable per-request journal, actual latency/CPU/heap evidence against the tagged baseline. The inspection report is preparation, not a measurement result.
- Catalog/affinity old/new code-switch compatibility and backup/restore verification remain pre-release gates.

## Validation

Each task has discriminating boundary/normal-path tests and independent spec/quality review. Root performs one fresh complete CI after final review and freezes the artifact including protected overlays. Changes may merge into local vNext after verification; no push or deployment. Source mechanisms and accounting limits must not be reported as measured whole-service performance improvements.
