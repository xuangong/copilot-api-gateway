# CFW Request Boundaries Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement and review each task. Mark completion only after its checks pass.

**Goal:** Separate reusable routing data, request execution, source-protocol preparation and background scheduling while preserving the existing gateway behavior.

**Architecture:** Keep the modular monolith and shared Responses turn. Introduce narrow, explicit boundaries rather than new services or a universal mutable context. Reuse accepted catalog generations without retaining request-bound providers in shared caches.

**Tech Stack:** TypeScript, Bun, existing provider contracts, SQLite and local Miniflare/workerd.

**Spec:** [Approved architecture direction](../research/2026-09-30-cfw-resource-remediation/reference-architecture-comparison.md). This plan implements the first bounded batch; the reference comparison's long-history store and dashboard changes remain separate projects.

**Closeout status (2026-09-30):** Tasks 1–3 are implemented, independently reviewed and integrated into local `vNext` through `298f37b8`. Frozen integrated CI passed 5,427 tests with one skip and no failures. Task 4's full performance comparison remains incomplete after two workerd initialization stalls; no sixth run is planned in this batch. See the [results](../research/2026-09-30-cfw-resource-remediation/request-boundaries-results.md) and [machine-readable evidence](../research/2026-09-30-cfw-resource-remediation/request-boundaries-local-metrics.json). No push or deployment occurred.

## Global constraints

- Work in `.worktrees/cfw-resource-rollback-fix` at the existing repair checkpoint. Preserve the pre-existing collaboration overlay and analysis documents. Do not create another dependency-heavy worktree.
- No CFW deployment, remote bindings, remote migrations, production data mutation, or Docker replacement. A local Workers dry-run is compilation only.
- Keep owner/key visibility, global upstream semantics, pin/composite fallback order, catalog authority/CAS and credential/incarnation checks.
- Keep all-upstream proxy preflight failures and existing cold/stale/error behavior. An invalid catalog or provider cannot silently become direct egress.
- Shared projection entries contain only immutable data. No request body/header/signal, provider instance, fetcher, credential supplier, scheduler, or dump accumulator may be retained there. Entries must be bounded and invalidated by every input that changes their projection.
- Keep native JSON upstream support and distinct body/event translation. Streams stay demand-driven without producer queues.
- The turn owns iterator cleanup, canonical terminal validation, necessary durable snapshot-before-success and completion. The WS session publishes local continuation only after native send acceptance and successful completion/cleanup.
- Preserve diagnostics defaults, existing usage/performance writes and failure timing. Do not change persisted formats or migrations in this batch.
- Add focused behavior/ownership tests, then run the required local checks once after integration. Do not quantify each change separately. Compare the complete batch against a frozen pre-change local artifact; report CPU/heap/latency evidence with its limitations.

## Task 1: Source-protocol preparation and cancellation ownership

**Files:**
- Create `vnext/packages/gateway/src/data-plane/chat-flow/responses/source-result.ts`
- Modify `vnext/packages/gateway/src/data-plane/chat-flow/responses/turn.ts`
- Modify `vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts` and `vnext/packages/chat-flow-kit/src/serve-template.ts` only for explicit controller reuse
- Add focused tests beside Responses turn tests and `serve-template.test.ts`

**Boundary:** A source preparation adapter accepts the legacy event result, the turn-owned raw iterable, streaming mode, upstream cancellation and an observation function. It returns only `AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>`. It does not own completion or schedule work. The turn's canonical loop consumes that source stream without hub reassembly or translator dispatch.

```ts
// Required conceptual output contract; final exported name belongs to this module.
interface ResponsesSourceFrames {
  readonly protocol: "responses"
  readonly frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>
}
```

- [x] Write a focused test that distinguishes JSON body translation from SSE event translation and proves no iterator pull before consumption. Add cancellation/late-failure coverage where existing tests do not already cover the boundary.
- [x] Run the new test to demonstrate the missing boundary, then implement the adapter. Keep JSON observation on hub frames and SSE observation on source frames, each exactly once. Preserve raw iterator ownership and bounded return handling in the turn.
- [x] Add an optional controller input to `prepareTemplate`; Responses passes its already-owned upstream controller. Other protocols retain their existing controller behavior. Verify object identity, original abort reason, cancellation before preparation and listener cleanup; do not create a third controller for Responses.
- [x] Run focused source-result, turn-barrier, abort-ownership, respond JSON/SSE and serve-template tests. Review only owned files; commit after the integrated ci:local gate.

This task intentionally leaves the cross-protocol producer's legacy `LlmEventResult` cast outside Responses. Record it as a remaining contract migration, not as completed global type normalization.

## Task 2: Immutable routing projection before execution construction

**Files:**
- Create a focused projection module under `vnext/packages/gateway/src/data-plane/providers/` and a shared deferred-candidate selection helper
- Modify `providers/registry.ts`, `routing/candidates.ts`, `routing/binding-resolver.ts`, `chat-flow/shared/select-binding.ts`, and the Responses/Messages/Gemini selection seams
- Add registry/projection/routing tests using existing real repository fixtures

**Boundary:** Introduce explicit internal `RoutingScope`, immutable catalog descriptors and an explicit asynchronous materialization seam in gateway routing. The provider contract itself remains unchanged. Separate the descriptor used for filtering/ranking from the ready-to-call binding. Do not introduce a lazy proxy whose synchronous methods conceal asynchronous construction.

```ts
type RoutingScope =
  | { readonly kind: "global" }
  | { readonly kind: "owner"; readonly ownerId: string }
  | { readonly kind: "all-owners" }
// Gateway selection keeps static descriptor data separate from this capability.
type MaterializeBinding = () => Promise<LlmProviderBinding>
```

- [x] Write focused tests proving ordinary routing constructs only the first usable matching provider, retries materialization failure in the existing order, and keeps request execution objects distinct between requests.
- [x] Cover owned-affinity selection separately: apply pure protocol/flag/translator gates first, then prepare every eligible candidate needed by the existing affinity rank; never turn owned selection into first-match selection.
- [x] Add projection invalidation tests for publication, row incarnation, provider/config generation, flag edits and disabled models. `catalogGeneration` does not cover filter/flag/order edits: use the current pinned fields or include them explicitly in projection identity. Never cache authorization or request execution.
- [x] Preserve global/owner visibility, pins, composite/direct preference, unknown-model versus unavailable-catalog behavior and all-upstream proxy preflight. Full model listings still include every visible model and preserve vendor/provenance data.
- [x] Implement a bounded per-repository immutable model projection plus explicit request materializer. On a cache miss, provider-owned capability declarations can be evaluated by a temporary provider, but none of its methods/closures may enter shared state. Prefer reusing that request's temporary provider when it wins. Request-token Copilot remains uncached.
- [x] Migrate the common selector and Responses/Messages/Gemini default selection to the same descriptor/materialization contract. Keep pricing, inbound headers, Responses interceptors, accepted model catalog seeding and execution affinity identity on the real materialized provider. Preserve preparation failures and catalog-error callbacks.
- [x] Run focused routing/registry/affinity and protocol attempt tests, review; commit owned changes after the integrated ci:local gate. The existing Responses `attempt.ts` collaboration edits must remain untouched or be preserved in an explicit partial-file commit.

## Task 3: Explicit request background scheduling

**Files:**
- Modify `providers/catalog-coordinator.ts`, minimal registry catalog-read wiring, `shared/dump/accumulator.ts`, and their tests
- Modify the narrow platform background API only if a safe scheduler capture helper is required

**Boundary:** Catalog refresh receives its scheduler through each read request, not through the long-lived coordinator's dependencies. DumpAccumulator captures its request scheduler when opened, and deferred branches use that stable capability. Do not change which writes are awaited versus deferred.

- [x] Add concurrent/scoped scheduler tests proving work stays with the originating request even when consumed outside its ambient scope. Use local promises and real existing storage fixtures; no database mocks.
- [x] Move the catalog scheduler into `CatalogRequest` and wire each registry read at the request boundary, preserving singleflight, freshness and fencing behavior.
- [x] Capture the scheduler at dump creation and replace deep ambient resolution in finalization branches. Retain existing asynchronous error handling and publication ownership.
- [x] Run catalog and dump lifecycle tests, review; commit after the integrated ci:local gate. Coordinate registry edits after Task 2 to avoid shared-file races.

## Task 4: Integrated local verification and evidence

**Files:**
- Add a compact local validation report under `vnext/docs/superpowers/research/2026-09-30-cfw-resource-remediation/`
- Keep generated bundles, raw local metrics and task ledger in this plan's ignored workspace

- [x] Freeze the pre-change repair source identity and a local executable bundle before modifying product files; retain the collaboration overlay in the artifact.
- [x] Run focused checks after each task, followed by `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` on the integrated candidate. Any unrelated failure is recorded separately from this batch's result.
- [x] Run existing local workerd HTTP/WS acceptance as part of the integrated CI suite.
- [ ] Complete a fixed-fixture before/after comparison without remote resources. Use the same settings, explicit completion/settlement, warmed workloads and no live account calls. Quantify the batch once; report local CPU/heap/latency separately from Cloudflare production limits.
- [x] Review the combined changes, record fixes and update this checklist. Preserve all available process cleanup and measurement evidence, including missing-result boundaries, without recreating large source/dependency copies.

**Deferred measurement:** `final-04` stalled before after-matrix warmup; `final-05` stalled before diagnostic warmup and was stopped by its external deadline. Both are `completed=false` despite process exit 0. The latter has independent evidence for 508 requests, 1,524 owned R2 objects, 22 settlement receipts and four dispatch receipts, but no final wire journal, recoverable latency summary, CPU profile or heap result. These partial records do not satisfy the 716-request comparison or CFW resource qualification. Earlier partial timings remain separate. Stabilizing phase/process isolation and writing a durable per-request journal must precede another measurement batch. Source integration is complete; the uncompleted checkbox records an evidence gap, not missing implementation in Tasks 1–3.

## Explicit follow-up work

- Bound and isolate local measurement phases, persist wire results per request, then obtain the missing full before/after latency, CPU and heap comparison.
- Full tagged cross-protocol execution-result migration beyond the Responses adapter.
- Further defer materialization from selection into the actual attempt, only if a later provider contract design can preserve preflight and selection error semantics.
- One immutable settlement fact feeding existing compatibility projections and explicit diagnostic policy; current defaults remain unchanged here.
- Catalog legacy-writer and affinity old-reader rollback compatibility before any CFW release.
- Item-reference history storage and dashboard aggregate loading under separate migration and total-cost designs.
