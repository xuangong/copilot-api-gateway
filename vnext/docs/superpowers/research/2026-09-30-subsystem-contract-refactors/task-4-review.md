# Task 4 independent review

Date: 2026-09-30. Reviewer: `subsystem_control_review`.

**Final verdict (2026-10-01): APPROVED.** The verified cleanup blocker below is resolved by the frozen fix-1 delta. No product files were edited during either review. The original finding and evidence remain below for traceability.

## Important: rejected producer domains bypass stream ownership cleanup

Locations: `chat-completions/respond.ts:352`, `messages/respond.ts:361`, `gemini/respond.ts:399`; related new nested-producer rejection at `shared/traverse-translation.ts:141`.

The three non-Responses renderers now call `eventProducerProtocol()` before selecting/creating the JSON or SSE consumer and its cleanup owner. If this new boundary rejects an invalid/missing/wrong-source producer, the function throws while dropping an already returned upstream event iterable: no iterator return is requested, no upstream cancellation occurs, and no normal source settlement runs. Responses validates inside its existing turn and correctly requests raw cleanup in its finalizer.

Independent reproducer: `task-4-invalid-producer-review.ts` in the worker evidence directory `.superpowers/sdd/2026-09-30-subsystem-contract-refactors/` relative to the isolated checkout. It invokes all four actual responders with an invalid tagged producer and an instrumented upstream-owned async iterator. It does not mock the responder or the boundary validator. Results:

| Source | Explicit rejection observed | iterator return calls | next calls | supplied controller aborted |
| --- | --- | ---: | ---: | --- |
| Chat Completions | yes | 0 | 0 | no |
| Messages | yes | 0 | 0 | no |
| Gemini | yes | 0 | 0 | no |
| Responses | yes | 1 | 0 | no |

The newly introduced `traverseTranslation` nested-producer rejection also returns an internal-error result without releasing `inner.events`. Normal production pinned hub selection does not intentionally create this condition, but rejecting that internal contract should release the execution it discards.

Required correction: route these rejections through an owned, bounded error cleanup path. Preserve source failure semantics rather than classifying the internal contract violation as user cancellation. Cover JSON and SSE invalid metadata and the nested-producer branch with a close/cancel observation. Do not consume unsupported frames merely to clean up, and do not add an unbounded wait on hostile iterators.

## Reviewed behavior with no additional blocker found

- The native/translated union makes hub frames opaque instead of pretending they are source frames. The actual traversal writes the producer tag, and all four protocol consumers use it instead of translator telemetry. Native byte-level provider responses remain unchanged.
- Chat and Messages cross-protocol attempts exit before the native-only interceptor chains. Their native assertions therefore match current placement. Responses cross dispatch remains inside its chain: the shared source helpers adapt consuming shims and preserve separate lazy body/event adapters for non-consuming transforms.
- Compact and multi-turn server-tool JSON paths now use the body adapter before source event synthesis, preserving body-only metadata/instructions. Streaming uses the event adapter. Replaced source streams remove the obsolete translated domain. The collaboration overlay adaptation separately preserves JSON restoration; its test does not claim currently unsupported cross-protocol namespace request support.
- Execution facts resolve after pending continuation settlement, bounded raw/source cleanup, and metadata observation only when existing sinks need it. Projection input does not await facts/completion, and facts do not await optional usage/performance/dump storage.
- Receipts report actual helper fulfillment/rejection/skipping and explicitly do not certify durable storage. Existing dump metadata -> usage -> performance order and error short-circuit remain, with dump finalization in `finally`.
- The compatibility completion still owns all cleanup/projections; the unchanged WebSocket session code waits on `turn.completion` and rejects incomplete cleanup before accepting reusable state. HTTP remains an early terminal consumer. No-sink final metadata remains unobserved.
- Source response and metadata references are shared rather than cloned into a second full completion graph. No CPU, latency or heap gain is inferred from the contract change.

## Evidence and scope

Reviewed `task-4-review-final.diff`, Task 4 brief/design/report, all changed runtime boundaries, actual attempt placement, common stream-tail/metadata helpers, existing renderer delivery, and WebSocket completion consumption. Reviewed the new producer-domain, active-shim, sink-lifetime and turn-barrier regression cases.

The implementation owner's 383 + 167 focused suites were not repeated, as requested by the integrator. The independent run in this review was limited to the newly identified cleanup gap. No full CI, dependency installation, Git mutation, deployment or service operation was performed. Re-review the focused fix before approval.

## Fix-1 independent delta review (2026-10-01)

Reviewed `task-4-fix-1-review.diff`, the new ownership helper, all producer guards and concrete terminal handoffs, traversal preservation, Responses source/interceptor adaptation, and the added Responses finalizer branch. No additional blocking finding was identified in this scope.

- A rejected result now requests iterator return and concrete body disposal without reading unsupported frames. The existing one-second cleanup bound covers both paths; throwing, rejected, or stalled disposal preserves the producer error.
- Each actual Chat, Messages, and Responses native terminal captures its own concrete body. Traversal and source-mapping wrappers retain that owner; a multi-turn rejection cleans the result for the rejected turn instead of consulting a mutable attempt-level response variable. The native Gemini source delegates through those owning terminals.
- Real-body responder rejection leaves the caller signal un-aborted and stamps internal error semantics. For legacy/custom fixtures without a concrete disposer, the three pre-turn responders still use the supplied controller as cleanup fallback; the rejection itself remains explicit. This narrower fallback should not be described as universal upstream/client controller separation.
- Responses performs the added disposal only after upstream abort. A rejected or timed-out disposer makes both raw cleanup facts and compatibility completion cleanup false; it does not change failed execution into caller cancellation. A normal completed turn performs no extra disposal and preserves the reusable response.
- The cleanup fix adds no persistence schema change and no new success-path sink ordering. The already reviewed facts/receipts and WebSocket completion boundary are unchanged.

Independent verification:

1. `bun test packages/gateway/tests/data-plane/chat-flow/shared/producer-cleanup.test.ts`: **19 pass, 0 fail, 60 assertions**. Includes an actual native Chat attempt with an unopened body, nested translation, source/interceptor guards, and actual Responses failed facts.
2. Original `task-4-invalid-producer-review.ts`, unmodified: all four responders now request **one return and zero reads**. The three legacy fixtures use fallback abort; Responses preserves its separate caller signal.
3. New `task-4-cleanup-lifetime-review.ts`: normal completion invokes disposal **zero times** and remains completed/reusable; throwing and rejected disposers settle failed with cleanup false; a hanging disposer settles the same way after **1002 ms**. All four cases leave the caller signal un-aborted. This is a bounded-cleanup observation, not a performance benchmark.
4. Frozen owned hashes: **42 files, zero mismatches**. `git diff --check` passed. The final gateway typecheck was reported green by the implementation owner after the parallel Task 6 type error was corrected; the integrator retains responsibility for fresh aggregate verification.

The implementation owner's broader 514/174-pass suites were intentionally not repeated. No full CI, dependency installation, Git write, deployment, or service operation occurred. Local contract/cleanup acceptance does not establish CFW memory, CPU, or latency improvement.

## Commit-isolation follow-up review (2026-10-01)

**Verdict: APPROVED.** Source review of `task-4-isolation.diff` confirms that the tracked producer-domain test now contains only the four compact/server-tool JSON/SSE cases. Both the collaboration source import and its now-unused translated-fixture import are removed. All eight remaining relative imports resolve to files present in tracked `HEAD`.

The two collaboration JSON/SSE cases were moved without changing their test body, assertions, producer fixture, invocation helper, or response reader. An independent source comparison confirmed byte-identical test body and helper definitions. The overlay-only test adds its own platform setup and database teardown; it retains a static required shim import, so missing overlay source cannot silently skip coverage. Both follow-up files match the frozen isolation hashes.

Reviewed the owner's clean-source log: the isolated tracked archive explicitly lacked the collaboration shim and passed **4 tests / 25 assertions**. The owner also reported the preserved-overlay pair passing **6 tests / 31 assertions**. These executions were not repeated, as requested. No runtime source, cleanup contract, or Git state was changed by this review. Commit only the tracked test removal; retain the new collaboration test with its untracked source overlay.
