# Private-state design review

Date: 2026-10-01. Focused read-only review of the private-state section of `vnext/docs/superpowers/specs/2026-10-01-contract-strengthening.md` and Task 3 of `vnext/docs/superpowers/plans/2026-10-01-contract-strengthening.md`. Parent supplied HEAD `aaa64942`; no Git operation was performed to refresh it. No implementation, tests, benchmarks, installation, restart, deployment, or subagents. This review file is the only authored artifact.

## Verdict

The ownership/authority design is suitable for this slice. One targeted Task 3 plan correction is required before implementation: make failed/timed-out nested cleanup observable through the existing cleanup channels, rather than copying the example that discards `closeStream`'s boolean. No additional public API, persistence, deep-copy/freeze policy, count/byte defaults, or Task 1 changes are warranted.

## Required correction

**P2 — Task 3's cleanup example erases the result that its surrounding contract promises to preserve.**

The specification says to bound iterator/body cleanup without converting timeout into false success (`spec:70`). Task 3 likewise says to propagate incomplete cleanup through existing failure channels (`plan:90`), but its normative algorithm uses `if (!finished) await closeStream(lifecycle)` and ignores the returned result (`plan:109-110`).

This has a concrete source consequence, not just a style concern. `shared/stream-tail.ts:89-97` resolves `false` when an iterator return rejects or times out. `responses/turn.ts:343-346` computes `rawCleanupComplete` from whether the returned outer iterator cleanup and `discardProducer` settle successfully. If a wrapper internally awaits `closeStream(slot)` but then resolves its own `return` or discard normally, the outer owner observes success even though the nested slot failed to close. `disposeEventProducerBody` similarly reports only whether its callback settles (`shared/producer-ownership.ts:35-37`).

Minimal correction: the lifetime helper owns one idempotent cleanup result covering the current slot, source iterator, and concrete producer disposal. Any constituent `false`, timeout, or cleanup rejection must make the externally awaited cleanup callback reject (or otherwise use an already-existing channel that the turn actually reads). Repeated `return`/discard must reuse that failed result, not later resolve successfully. Abort must attach a rejection handler to avoid detached unhandled rejections while retaining the failed result for the consumer. Replace the plan example's ignored boolean with an explicit handoff to that owner.

Preserve the original failure/error chain and keep final metadata settlement in an independent `finally`; cleanup failure must not prevent the existing metadata promise from resolving once. Do not introduce a second request outcome, a new receipt API, or alter normal terminal/continuation ordering just to carry this cleanup fact.

Add one focused acceptance assertion: a never-settling/rejecting slot return releases private state immediately, then causes existing turn cleanup observation to remain incomplete, even if the outer iterator itself was never started. A separate late-resolution assertion must confirm no new write/run/yield after closure. Assert both properties; observing an empty retained reader alone proves facade closure, not provider cleanup.

## Design that should remain as written

- **Owned source versus borrowed store:** keeping the existing default export name as an owned-source descriptor preserves the protected registry. Legacy injection remains borrowed, preserves direct replay/TTL behavior, and never gains accidental disposal authority. Invocation closure stops its local adapter without clearing the external store.
- **Typed payload without resource copies:** the current v1 web-search shape is enough. Validate consumed foreign fields at the borrowed boundary; owned typed reads need no repeated deep decoding. Explicit trusted-reference mutation rules correctly avoid an unsupported claim of deep immutability. No clone/freeze is required for this slice.
- **Lazy allocation:** one stable preparation reader facade forwards to the invocation-local scope once hosted work activates. Scope/Map/listener/result-wrapper allocation stays out of inactive and default replay-only paths. A captured facade must continue to see later owned writes; substituting a permanently empty reader during preparation would violate the stated stable-facade contract.
- **Lifetime scope:** one outer hosted invocation covers all upstream tool turns, including `include` absent replay. No live TTL expiry, global sweep, or reset per `run()` is appropriate. Explicit closure outside generator `finally` is necessary for before-first-next return/throw/discard/abort.
- **Current resource tracking:** a currently active slot is registered before its first pending `next`; a currently owned producer is registered before any materialization await. A result arriving after closure is disposed before metadata mutation, input rewrite, another upstream run, or output. This can use private helper state; no new source/transport owner is needed.
- **Metadata:** before-first-next closure settles the existing first-result identity once; later observation cannot overwrite already settled metadata. Normal drain continues to use the existing last-observed identity/performance resolution. Cancellation and cleanup do not manufacture completion success.
- **Deferred capacity:** the specification explicitly avoids claiming count/byte or complete request-memory bounds. No hidden length limits or new overflow semantics should be added to the borrowed decoder or default writer during this task.

## Minimal implementation shape

Keep the specified capability interfaces and dependency union; do not add generic plugin families, item-kind registries, owner-ID namespaces, resolver/seed APIs, or transport-specific constructors. `server-tool-lifetime.ts` can remain a private helper with methods to attach/detach the current slot/producer, check closure at async boundaries, close state synchronously, and await the memoized bounded cleanup result. The shim retains control of public frames and metadata; the helper retains only resource closure bookkeeping.

The expected implementation files already listed in Task 3 are sufficient: new `orchestrator/server-tools/private-payload.ts`, existing `private-payload-store.ts`/`types.ts`, new `responses/interceptors/server-tool-lifetime.ts`, existing `server-tool-shim.ts`/`server-tools/web-search.ts`, and focused contract/lifecycle fixtures. The protected `responses/interceptors/index.ts`, Responses attempt overlay, result union, snapshot store, and turn implementation do not need design-driven edits.

## Review limits

This is a design review against current source semantics, not executed lifecycle verification. It establishes the boolean-cleanup propagation gap in the plan example; it does not establish a production leak, quantify memory savings, or claim that ordinary public cross-request history depends on the old singleton. Implementation review must check actual cleanup promise propagation and exact callback identity, especially for nested translated producers and a later inner `run()`.

## Focused follow-up: required correction resolved

Date: 2026-10-01. Re-read only the revised Task 3 cleanup contract and example. The example now checks `closeStream(lifecycle)` and calls `lifetime.recordIncompleteCleanup()` on `false`. The adjacent requirement explicitly retains a monotonic failure flag, rejects the composite cleanup promise for any tracked close/disposal failure or timeout, and prevents a later successful outer close from erasing that failure. It also states that final metadata settles independently and cleanup errors must not replace the original wire failure.

This resolves the previous P2 design/plan finding. **Design verdict: approved for the specified private-state slice; no outstanding design finding from this review.** Implementation still needs to prove the specified propagation through the actual externally awaited return/discard callback and its lifecycle fixtures. This follow-up made no product source change, ran no tests, and performed no Git operation; approval concerns the revised contract, not implementation verification.

## Focused follow-up: synchronous capability return types

Date: 2026-10-01. Read only the latest private-state interface/compatibility paragraphs in the specification and Task 3 plan. **Approved; no new finding.** The new `ServerToolPrivatePayloadWriter.registerPrivatePayload` and `OwnedServerToolPrivatePayloadScope.dispose` now return `undefined`, which rejects Promise-returning async implementations and broadly typed `void` implementations at the trusted type boundary. This matches synchronous registration-before-terminal-output and immediate private-reference release, without introducing an asynchronous store protocol or lifecycle owner.

Both interfaces are new, so this narrowing has no historical source-compatibility obligation. The legacy injected `PrivatePayloadStore` correctly retains its original `void` signature and trusted synchronous convention; the specification explicitly says the adapter cannot prove a foreign implementation's synchronicity. A synchronous typed adapter is therefore not misrepresented as runtime enforcement of a legacy async implementation. The Task 3 interface paragraph also requires compile assertions for async/broad-void rejection.

This is a type-design approval only. The type does not prohibit deliberately detached work inside a trusted synchronous function or an unsafe cast, and the trusted-code boundary remains as specified. No evolving product code was read, no test/typecheck or Git operation was run, and only this review was appended.
