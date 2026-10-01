# Execution contract matrix

Date: 2026-10-01. Implementation status is tracked in the linked plan; final verification is recorded separately in qualification.

| Phase | Owner / capability | Boundary to enforce | Behavior preserved |
| --- | --- | --- | --- |
| Search preparation | Execution-bound prepared batch | No provider work; one start; closed scope rejects before expansion | Existing parser cardinality, actions and argument slices |
| Search start | Invocation search scope | Immediately observe every eager branch and provider-plus-usage leaf | Concurrent search fanout, shared page fetch and ordering |
| Provider resolution / fallback | Scope signal and provider guards | No invocation of a later engine or retry attempt after cancellation | Ordinary error/empty fallback and existing retry policy |
| Search delivery | Started call result accessor | Cancellation revokes delivery; late result cannot repopulate cache | Normal IR, snippets, citations, refusal and replay payloads |
| Search retirement | `cancel(): undefined` + `settled(): Promise<void>` | Synchronous revocation is separate from actual asynchronous settlement | No new request outcome or normal search deadline |
| Responses hosted work | Existing ServerToolLifetime adopts hosted.work | Adoption before further preparation/run; cancellation before slot acquisition | Source producer, final metadata, private writer and completion owners |
| Chat hosted work | Local lazy-result lifetime | Explicit unstarted/pending cancellation; dispose current and late producers | Native frame pipeline, tool handoff, usage and turn budgets |
| Diagnostic stream preparation | Request-owned subscription controller | Observe raw abort before snapshot; late SQL does not start delivery | Subscribe before live snapshot; snapshot/appended wire events |

## Relationship to earlier contracts

The preparation contracts select the correct protocol path. Producer-domain contracts validate actual native/translated events before consumption. Private-payload capabilities keep readers separate from the invocation writer/disposal owner. Capture admission/retirement separate retained accounting from terminal resource release. Subscription-owned diagnostic channels remove inactive channel state.

This increment extends that chain into eager search execution and request preparation cancellation. An output iterator is not sufficient evidence that underlying provider promises are owned. Likewise, stopping delivery is not evidence of underlying settlement, and durable diagnostic rows are not evidence that a reconnecting client has received every notification.

## Contract chain and extension points

The earlier contracts remain distinct owners. This increment adds an execution capability to that chain; it does not make one generic lifetime class responsible for every subsystem.

| Existing design | Responsibility retained | Extension point in this increment |
| --- | --- | --- |
| [Reference-led request stages](../../specs/2026-10-01-reference-led-stage-contracts.md) | Explicit preparation and selected execution path | Hosted search separates side-effect-free preparation from one start |
| [Interceptor contracts](../../specs/2026-10-01-interceptor-contracts.md) | Protocol-specific ordering, producer shape and completion ownership | Responses adopts work before later preparation; Chat uses its own narrow adapter |
| [Strengthened producer/private-payload contracts](../../specs/2026-10-01-contract-strengthening.md) | Validated event domain, writer/read/disposal capability separation | Search work exposes cancellation and settlement without terminal-response authority |
| [Diagnostic resource contracts](../../specs/2026-10-01-diagnostic-resource-contracts.md) | Capture retirement, subscription lifetime and storage-before-notification | Raw request cancellation reaches the eager subscription before snapshot preparation |

Future admission belongs before the work it bounds: operation admission before expansion/start, body admission before full parsing, and replay/cache admission before retention. Completion and persistence owners should consume an explicit outcome from those decisions. A cancellation receipt cannot replace an admission decision, and an observed notification cannot replace durable readback or client reconciliation.

## Remaining gaps and next priorities

1. Operation admission before parser expansion, slot allocation and provider start still needs a quantitative policy. Existing turn limits are not operation budgets. The new prepare/start boundary provides an integration point but does not itself bound work.
2. Search success-body ingress, retained private replay and active page cache each need their own byte/count policy. An output truncation cannot cap earlier parse allocations. Trusted external provider/store internals remain outside local ownership guarantees.
3. Diagnostic active queues/publication count require explicit loss/recovery semantics. Current latest-page reconnect and completedAt/id pagination do not provide a durable commit-ordered catch-up cursor. Do not enable shedding under a lossless claim.
4. A noncooperative provider or usage repository can exceed bounded caller cleanup while its real settlement remains pending. Immediate observation and revoked delivery remain required; forceful termination is not guaranteed.
5. After the contract changes are complete, qualify numeric policies and aggregate resource effects with representative local workerd workloads against the tagged deployed baseline. Then verify catalog/affinity old/new rollback and backup/restore before selecting any release artifact.

No operation cap, result-body cap, replay-byte cap, connected-subscriber queue cap or global memory bound is claimed. No CFW CPU, memory or latency improvement was measured in this increment.
