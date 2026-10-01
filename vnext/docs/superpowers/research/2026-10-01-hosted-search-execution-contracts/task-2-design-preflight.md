# Task 2 design preflight

Date: 2026-10-01. Reviewed the committed hosted-search execution specification and implementation plan at `fdc8c51568fee242541387a153f84b0038f3ba70`. Scope: Responses work adoption and Chat Completions lazy-result ownership only. This is not a review of Task 1 implementation. No code changes, tests, benchmarks, services, network or Git/index mutations were performed. This file is the only new artifact of this preflight.

## Decision

The design is implementable without relocating `ServerToolLifetime`, editing protected attempt/registry overlays, changing protocol completion owners or introducing a generic execution engine. Keep the selected tools-owned scope, optional Responses hosted-work capability and local Chat result wrapper. No architectural blocker was found. Two concrete contract/example details in the committed baseline were reported below. A final readback during this preflight confirms that the parent has already corrected both in the current working specification/plan: cancellation returns `undefined`, and the example initiates close, resolves the provider, then awaits close. No design blocker remains from this preflight.

## 1. Preserve the synchronous cancellation capability in its type

The committed baseline specification's Responses integration uses `{ cancel(): void; settled(): Promise<void> }` (`specs/2026-10-01-hosted-search-execution-contracts.md:42`), and that baseline plan repeats `void` for both the scope and `ServerToolHostedWork`. The archived audit's final recommendation used `cancel(): undefined` expressly to exclude asynchronous implementations.

TypeScript permits an async implementation where a void-returning method is expected. A callback which waits before aborting can therefore satisfy the public type yet violate the required synchronous no-new-start/no-delivery gate. Calling it synchronously or ignoring its return value does not repair that contract.

Recommendation: declare `cancel(): undefined` for `WebSearchExecutionScope` and `ServerToolHostedWork`, with the concrete cancellation method returning `undefined` after revocation. The work adapter continues to expose no outcome authority. If `void` is retained deliberately, describe synchronous behavior as a trusted implementation obligation rather than a statically enforced capability; the built-in implementation must still revoke synchronously. This is a type-contract strengthening, not a request to add another runtime engine.

## 2. The Task 2 RED example needs settlement ordering consistent with the contract

The committed baseline plan's example awaits `result.discardProducer()` before resolving `providerDeferred`. For a fixture that leaves its provider promise pending after abort, the required real-settlement receipt remains pending and the bounded cleanup wait must report incomplete cleanup. It cannot unconditionally return normally before the next line resolves that provider.

For the cooperative/late-success cleanup case, initiate and immediately observe the close promise, assert synchronous signal revocation, settle the deferred provider, then await the already-observed close outcome. For example:

```ts
const closeOutcome = Promise.resolve(result.discardProducer?.()).then(
  () => ({ ok: true as const }),
  error => ({ ok: false as const, error }),
)
expect(providerSignal.aborted).toBe(true)
providerDeferred.resolve(success)
expect(await closeOutcome).toEqual({ ok: true })
```

Use a separate noncooperative case to expect incomplete cleanup after the existing cleanup wait, while the actual scope settlement remains pending. Alternatively make the first fixture explicitly reject its provider promise on abort. Do not change the scope's settlement receipt merely to satisfy the original pseudocode.

## Adoption and Chat boundaries that remain feasible

- Responses currently creates its lifetime after registration preparation. Immediate work adoption can use the archived audit's small host-owned pending-work list, transferred to the hosted lifetime before the first upstream run; all preparation exits cancel that list. Creating the outer resource lifetime lazily at the first returned hosted work also works if inactive/replay-only allocation and private-scope closure semantics stay intact. In either implementation, do not delay adoption until slot acquisition.
- Cancellation must run in the synchronous close phase; the existing lifetime resource callback is deferred. Settlement belongs in its asynchronous cleanup phase. Catch a failing cancellation callback per work item so remaining items are still revoked.
- The Chat wrapper must exist before the first `run()` is awaited, so first-run rejection, non-events return and late first-result arrival also release the newly allocated search scope. A wrapper constructed only after the first event result would miss that preparation window.
- The Chat helper owns one idempotent disposal record for each acquired producer and the currently pending upstream factory result. Producer validation already disposes an unsupported result; avoid disposing that same result twice when wrapper cleanup follows validation failure. This is local resource bookkeeping, not a new producer or completion protocol.
- A pending read can be rejected promptly while its underlying operation remains observed. Preserve that separation from bounded close waiting and from the actual settlement receipt. These requirements do not conflict.

## Archive check

The tracked file `vnext/docs/superpowers/research/2026-10-01-hosted-search-execution-contracts/search-design-audit.md` is byte-for-byte identical to `.superpowers/sdd/2026-10-01-hosted-search-execution-contracts/search-design-audit.md` (`diff -u` returned exit 0). It already includes the final addenda: direct Alpha API compatibility, the optional low-level task tracker, the explicit hosted-work lifecycle, the local Chat wrapper decision, and the two-task implementation split. No archive repair is needed. The committed specification deliberately uses slightly different public names and a scope-bound `prepare().start()` shape; that shape is consistent with the audit's ownership recommendation.
