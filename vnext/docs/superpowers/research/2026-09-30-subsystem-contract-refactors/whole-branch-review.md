# Whole-branch review

Date: 2026-10-01. Independent final combined-contract review.

Reviewed runtime candidate: `15404d956f9588606a4f16af843c9a4ec292f475`, against `57501ed3`, including the supplied scoped overlay adaptation. Also reviewed the test-only CI correction in `integration-ci-fix.diff`, subsequently committed as `3a44ab10`; it does not change the runtime source verdict.

Resolution: the sole P2 below is fixed in `9e54b9a2` and superseded by the [approved scoped re-review](final-fix-review.md). This document preserves the initial finding and evidence.

## Independent verdicts

- **Spec: changes required.** Tasks 1–5 match the approved contract direction in the reviewed source. Task 6 is correctly documented as partial overall, but its implemented retained-payload slice does not yet cover an ordinary preparation-stage cancellation exit. That violates its release contract independently of the explicitly deferred publication-concurrency work.
- **Quality: changes required.** One verified material P2 finding below. No other material source findings were confirmed in the combined review. This is not a production-performance or rollout-readiness assessment.

## P2 — Release capture reservations when ordinary chat preparation exits exceptionally

**Changed ownership location:** `vnext/packages/gateway/src/shared/dump/accumulator.ts:182-190` reserves capacity before request preparation; `:213-214` releases it only through a terminal retirement path. The combination with `vnext/packages/chat-flow-kit/src/serve-template.ts:280-284` is incomplete: rejection of `prepareTemplate()` or `hooks.respond()` bypasses `dump.finalize()`. The ordinary HTTP Chat Completions caller at `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/http.ts:12-16` likewise has no exceptional-exit handoff.

**Real trigger:** a dump-enabled request is cancelled after its body was buffered but before/during binding preparation. `ClientDisconnect` passes the already-aborted request signal into the serve layer. `CatalogCoordinator.read()` rejects with `Model catalog aborted`, and `providers/registry.ts:325` intentionally propagates errors on the aborted signal. The exception escapes the shared serve wrapper, so the accumulator never enters `retire()`. Request-body preparation can settle and the accumulator itself can become unreachable, but the environment owner's numeric reservation is never decremented.

**Verified impact:** this is a permanent accounting leak for that environment, rather than a claim of retained V8 payload bytes. Repeating such cancellations consumes the shared 16 MiB admission allowance, after which unrelated later captures are explicitly omitted as `environment_limit` until the environment is reset. Inference can continue, but configured diagnostics lose payloads due to already-ended requests. This is not the accepted metadata/publication-concurrency gap.

**Executable evidence:** `whole-branch-capture-exception-probe.ts` in the worker evidence directory, with output in `whole-branch-capture-exception-probe.log` in the same worker evidence directory. Run from the isolated checkout:

```sh
bun .superpowers/sdd/2026-09-30-subsystem-contract-refactors/whole-branch-capture-exception-probe.ts
```

The probe uses the real Bun SQLite repository, real `FileDumpStore` and filesystem storage, and the production `serveChatCompletions` path. It installs one local fixture upstream and supplies an already-aborted signal, so the catalog rejects before provider discovery or any upstream request. There are no database mocks. The deliberately lowered 1000-byte environment budget makes the consequence visible with a 200-byte captured request:

```text
serve rejection: Model catalog aborted
retained after cancelled serve: 856
later capture: { state: "omitted", reason: "environment_limit" }
retained after later finalized: 856
retained after explicit manual finalization: 0
```

The final explicit finalization is probe cleanup and demonstrates the missing owner handoff; production does not perform it. The script removes its own temporary files and closes its isolated SQLite connection.

**Required correction:** give the capture owner a terminal path for preparation/respond exceptions, including cancellation before an HTTP response exists. Keep the existing exception/cancellation semantics and hold reservations until already-started request preparation and any chosen terminal persistence have actually settled. Do not remove the budget, release prematurely while preparation runs, or depend on garbage collection. Check the shared Chat Completions/Messages/Gemini wrapper and any other direct accumulator callers for the same exit category. A focused regression should prove both rejection semantics and recovered admission for the next capture.

## Combined contract checks

- **Catalog retention versus authority:** `catalog-coordinator.ts:111-134` creates request-local views and returns accepted observations even when payload admission rejects them. `catalog-retention.ts` keeps model/byte retention separate from bounded scalar ordering heads; stable publication observations do not trigger global retention-rejection fencing. Identity change, target invalidation, eviction and clear retain their distinct ordering roles. The real SQL/CAS implementation is not replaced.
- **Configuration versus live commands:** `configuration-ports.ts` exposes explicit read methods without a repository proxy fallback. `configuration-cache.ts:292-306` exhaustively classifies logout and other writes. `repo/index.ts` routes renewable credential reads and CAS state commands through current authority; catalog and usage owners are separate. The existing HTTP/WS enabled-owner policy difference remains intact.
- **Quota:** `repo/usage-quota.ts` preserves every bucket identity column in its price fallback, including null/empty upstream equivalence, and preserves known zero. `observability/quota.ts` retains no-quota elimination, request-first denial, UTC ranges, soft fail-open via its unchanged gate, and the narrowly triggered legacy detail fold for floating-point boundary compatibility. The result-volume reduction is a mechanism, not measured latency or D1 scan savings.
- **Producer and completion:** producer tags select collectors independently of `translatorPair`; translated body and event adapters remain independent. Source-consuming Responses interceptors materialize once and stream-only wrappers preserve JSON adaptation. Rejected producer ownership carries the concrete body disposal hook as well as bounded iterator closure. `responses/turn.ts` resolves facts before optional projection operations, labels receipts as operation settlement rather than durable acceptance, and still resolves compatibility completion after finalization. `responses/session.ts:248-253` continues to gate reuse on that completion and cleanup result.
- **Declarations:** the exhaustive provider map owns actual lookup keys and preserves unknown-kind failure behavior. Naming `PrepareTemplateResult` does not introduce a second preparation/execution state machine.
- **Capture representation:** the projection accounts retained strings/containers and copies admitted JSON graphs without retaining hidden producer state. Overflow omits the whole payload with persistent/exported/UI-visible metadata; the store and broker settlement paths are included in retirement when finalization is entered. The missing exceptional entry into that lifecycle is the finding above.

## Test and overlay isolation

The supplied CI correction replaces the obsolete `pinned.catalogs` access with the explicit authoritative repository. The two real SQLite connections and sibling-write observation remain; assertions now additionally prove that the pinned read port has no catalogs capability and keeps the prior metadata generation. This delta is approved by source inspection. Its reported 28-pass result belongs to the implementer's run, not a rerun by this reviewer.

The tracked `responses/interceptors/producer-domain.test.ts` contains only compact/server-tool cases and no collaboration-shim import. The separate `producer-domain-collaboration.test.ts` is the companion overlay test and must remain with its untracked shim. A read-only scan checked 73 added relative test imports in the scoped diff (excluding that companion): all resolved on disk and none added a collaboration-shim dependency. Original unrelated overlay changes are outside this review and must not be swept into scoped commits. Main-checkout hash preservation and integration remain the root agent's responsibility.

## Evidence limits and remaining gates

Read the supplied whole-branch diff, brief, progress/rulings, plan, architecture/implementation record, capture policy, production call paths and relevant regression sources. Ran only the focused executable probe above; did not rerun broad suites, install dependencies, restart services, perform Git writes, deploy, or access production.

The parent's first integrated suite found an already-assigned stale test (`pinned.catalogs`); that is covered by the reviewed test-only correction and is not duplicated as an unassigned finding here. Full CI qualification is separately owned by the parent and does not supersede this newly verified source failure.

Task 6 remains partial after this fix: publication/metadata concurrency still needs explicit admission-failure semantics. Full ingress/materialization, legacy tee queues, optional upstream-prefix ownership, encoder/compression scratch and runtime overhead remain outside the retained-payload estimate. Projection adds per-frame traversal/container-copy CPU. Exact-artifact CPU/heap/latency comparison, old/new data rollback compatibility, clean integration and deployment qualification remain separate gates. Item-reference storage, strict quota reservation, durable accounting outbox/idempotency and HTTP/WS auth-policy convergence are unchanged follow-up projects.
