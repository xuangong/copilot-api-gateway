# Resource admission matrix

Implementation/review status is tracked in the [plan](../../plans/2026-10-01-resource-capacity-policy.md). This matrix describes the candidate design; qualification is not yet complete.

| Phase | Owner | Decision before work | Excess outcome | Quantity not covered |
| --- | --- | --- | --- | --- |
| Hosted call admission | Invocation search scope | Operation units before expansion/slots/start | Fail offending call via existing protocol owner | Already-decoded raw arguments |
| Successful provider ingress | Reader plus invocation byte debit | Whole chunk before copy/full parse | Stop reading; no fallback/reentry | Runtime chunk allocation and parse expansion |
| Private replay retention | Owned private writer | Graph charge before insertion/completed frame | Atomic rejection; preserve earlier entries | Borrowed external legacy store |
| Page cache retention | Scope-owned cache | Key/value charge before successful publication | Failure without eviction/refetch | Temporary provider result graphs |
| Chat continuation | Chat result owner | Newly generated messages/annotations before append | Failure without next upstream run | Initial history, current-turn stream assembly and caller-retained output |
| Diagnostic subscription | Bounded broker iterator | Encoded frame count/charge before queue/decode | Detach, clear queue, latch finite recovery reason | SQL rows and codec transients |
| Diagnostic stream preparation/delivery | Route permit | Immediate permit before subscribe/list | 429 without waiting; existing owners retire after actual work | Unrelated persistence/publication work |
| Diagnostic recovery | Dashboard generation | Visible latest-only scope, explicit refresh | Continuity remains unknown | Complete historical replay and cross-isolate delivery |

The existing cancellation/settlement, producer-domain, private-reader/writer and terminal-response contracts remain in force. Admission does not own protocol completion; cancellation does not certify physical termination; notification receipt does not certify complete persisted history.

## Release gates still separate

1. One newly frozen exact-artifact local CI for this implementation.
2. Correct and review the local workerd measurement runner, then compare the final candidate against deployed tag e660fb4d. Include representative hosted search and diagnostic saturation workloads separately from ordinary request timing.
3. Verify catalog/affinity old/new rollback with real compatible schema/readers, and backup/restore procedures.
4. Design aggregate diagnostic publication receipts and bounded browser history/full-detail policies separately. They are not covered by live queue limits.

No whole-service CPU, memory or latency improvement has been measured in this increment.
