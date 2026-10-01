# Resource contract follow-up

Date: 2026-10-01. This increment continues the local architecture work; it does not qualify a production release or report measured CPU, memory or latency changes.

## Ownership and capacity are distinct contracts

| Area | Established before this increment | This increment | Remaining qualification or design |
| --- | --- | --- | --- |
| Dump capture | 4 MiB per capture, 16 MiB shared retained estimate, 8,192 frames; explicit omission and diagnostic-only failure | Separate admission and retirement capabilities; private accounting; release only after preparation and terminal work settle | These estimates are not heap measurements or an isolate-wide resource bound |
| Live diagnostic channels | Eager process/isolate-local fanout, durable storage before notification | Subscription-owned entries; no encoding without recipients; graceful drain versus cancellation; pending-read settlement | Active subscriber item/byte admission and overflow/reconciliation policy |
| Hosted private replay | Invocation-owned scope, validated borrowed legacy-store reads, cleanup across lazy response lifetime | Source audit and proposed admission boundary only | Invocation-wide operation admission before expansion/provider start, then separate replay retention admission |
| Search provider results | Result/snippet/page output shaping and capped error reads | No new production limit | Success-body admission before complete parse, page-cache retention, cancellation of eager provider work |
| Diagnostic publication | Owned staged uploads, all-started settlement, row-before-notification ordering | Existing owners and persisted format preserved | Aggregate metadata/publication concurrency; capture bytes alone do not bound task count |
| Diagnostic read/UI | Existing full detail/export and live metadata views | No behavior change | Bounded preview and UI history retention with explicit reconciliation |
| Continuation and affinity | Existing authoritative completion and opaque-state ownership | No behavior or storage change | Catalog/affinity old-new rollback compatibility; preserve required keys and verify migration/recovery |

## Priority after this increment

1. Design hosted invocation admission as an operation budget shared across original calls and tool-loop reentries. Require an admitted decision before array expansion, plan/slot construction and eager provider start. Route exhaustion through the existing response failure owner; an indefinitely repeatable refusal slot is not a bound.
2. Separately design success-body ingress, retained replay and page-cache policies. Terminal replay admission cannot undo provider work already started. Keep external stores explicitly outside owned-capacity guarantees.
3. Specify live diagnostic queue and publication admission, including exact overflow/reconciliation behavior. Keep storage authoritative and distinguish lost notification visibility from lost persisted data.
4. Qualify candidate policy values with representative local workerd workloads and compare the frozen candidate against the tagged deployed baseline. Then complete catalog/affinity rollback compatibility and data-backup/recovery verification before any deployment decision.

No numeric policy is selected by this document. The source audit establishes where admission must occur, not safe throughput, peak heap, or a global memory bound.

## Reference strengths retained

Reference checkout: `1d7dcd923e260e425120cca0c7a240e93720af27` at `/Volumes/Projects/copilot-gateway` (read-only audit).

Its explicit host broker port, cancellation/pending-read ownership and source-owned scratchpad support narrow phase and capability contracts. The current gateway keeps those architectural strengths while preserving its own native JSON, hosted fanout, continuation and diagnostic storage semantics. The reference's scratchpad cloning, unbounded live queues and no-recipient channel allocation are not capacity solutions to copy.

See [diagnostic audit](diagnostic-capacity-audit.md) and [hosted-search audit](hosted-search-capacity-audit.md) for source locations, current behavior and implementation boundaries. Their baseline findings remain historical audit evidence; completion and validation are recorded separately in this increment's qualification.
