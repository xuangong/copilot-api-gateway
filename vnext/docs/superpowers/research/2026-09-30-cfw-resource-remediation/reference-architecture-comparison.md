# vNext and Floway: architecture comparison

Snapshot note: this analysis describes the pre-architecture repair candidate. The subsequent bounded implementation, verification and remaining gaps are tracked in [request-boundaries-results.md](./request-boundaries-results.md); the original source observations and measurement conclusions below retain their checkpoint scope.

Date: 2026-09-30. This is a source-based architecture assessment, not an implementation plan or a new performance experiment.

## Decision and evidence boundary

Keep vNext's platform/provider/protocol separation, shared Responses turn, bounded transport/capture ownership, configuration snapshots and authenticated affinity. Adjust how routing, request state, translation and observation cross those boundaries. The recommendation is incremental restructuring inside the existing gateway, not a rewrite or wholesale adoption of Floway.

The package boundaries are broadly reasonable. The weaker boundary is between immutable configuration, request-owned state, mutable attempts and completed records: these currently cross several adapters, closures and result shapes. Improving that boundary can remove repeated work and make lifecycle rules easier to enforce, but source inspection does not establish a CPU saving.

Compared sources:

- Main checkout: `/Volumes/Projects/copilot-api-gateway`, `vNext` at `42b20f311173b1981e03a33b7f1b6460a8601d1b`, with existing uncommitted work.
- Repair checkout: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`, `fix/cfw-resource-rollback` at `54f1a4e43ea3bedebff16b362c3378a6cf841c80`, with the preserved collaboration overlay. It is not merged into vNext.
- **B**, the current product source used for detailed comparison: `/Volumes/Projects/copilot-api-gateway-cfw-validation-20260930-001627/p0-repair/source-optimization-ci-03/vnext`. This is the frozen, complete measured candidate, including the overlay; manifest SHA-256 `0d909fba9d74f67d09d8fdb35ddcb528d2e1dd35f45050d433231d79e368bb01`.
- **R**, the reference checkout: `/Volumes/Projects/copilot-gateway` (also reachable at the user-provided `/Users/zhangxian/projects/copilot-gateway`), clean at `1d7dcd923e260e425120cca0c7a240e93720af27`. Its current product name is Floway. This assessment did not fetch a newer revision.

Source paths below are relative to B or R. The existing [measurement](./source-optimization-results.md) compares the complete candidate with the deployed old version, **not with Floway**. No equivalent Floway benchmark was run. The [ordinary-path cost analysis](./source-cost-analysis.md) remains the evidence for which features that fixture exercises. Earlier architectural observations in [architecture-review.md](./architecture-review.md) describe their own older checkpoints; they are not current measurements.

## Comparison

| Area | Current vNext | Reference Floway | Assessment |
| --- | --- | --- | --- |
| Runtime and package composition | Bun/CFW adapters, portable platform contracts, pure protocol/translation primitives, gateway composition | Node/CFW adapters, portable platform/provider/interceptor packages, gateway composition | Both have a sensible modular monolith. Package count is not evidence of request cost. |
| Request ownership | Explicit args plus kit extras, attempt context, telemetry context, turn options and scoped ambient services | Explicit GatewayCtx/ChatGatewayCtx carries scheduler, scope, dump and attempt state | Borrow explicit ownership, without creating one unbounded mutable context or caching it. |
| Protocol result | Cross-protocol results can contain hub events typed as source events, with translation callbacks consumed later | Translation traversal returns source-protocol events directly | Make the normalization seam honest; retain native JSON semantics. |
| Responses HTTP/WS | Shared turn owns output, terminal validity, required durable snapshot commit and completion; session owns connection-local continuation publication | Shared preparation/output helpers, but separate HTTP and WS observers/finalization | Keep vNext's shared turn and session ownership. Consolidate mechanisms within them, not the guarantees away. |
| Configuration/catalog | Pinned configuration, authorization lease, bounded warm catalog memo, distributed D1 refresh fencing | Durable cached catalog in upstream rows; reads return a snapshot and schedule execution-cell refresh | Keep vNext's warm path and authority. Borrow the read/publish separation, not the entire runtime. |
| Routing materialization | Registry mixes catalog read, provider construction, model projection and request fetcher setup | Separates some contracts, but still reads rows, builds providers/hashes and projects catalogs per request | Build immutable routing descriptors separately from request-specific execution objects. Neither implementation is an ideal template to copy verbatim. |
| Diagnostics | Bounded demand-driven capture, prepared dump ownership, three files when sidecar exists | Full request buffering and response-chunk retention, also a third capture file when enabled | vNext has useful CFW safeguards. Add explicit diagnostic policies; do not adopt reference full-body retention. |
| Telemetry | Legacy performance and new metrics writes coexist with usage/dump completion | Central settle helper and performance summary/histogram projection | One settlement fact with compatible projections is a cleaner long-term contract. |
| Stateful Responses | Full input/output history in each stored snapshot | Immutable API-key-scoped items; snapshots contain item references; large payload spill | Item references are worth a separate long-history redesign with migration and GC compatibility. |
| WS capacity | Explicit admission, input/output/local-state limits and transport pressure contract | Serial Promise queue with a simpler socket interface | Preserve vNext's bounds and acceptance semantics. |

## 1. Retain the modular monolith and the shared turn

Both projects already separate deployment-specific adapters from portable gateway logic. vNext enforces data-plane/control-plane/repository and protocol/translation dependency directions in `eslint.config.mjs:23` and framework/business separation in `scripts/check-framework-purity.ts:1`. Its `packages/service/src/index.ts:10` and `packages/result/src/frame.ts:1` are small contracts/helpers. Removing packages or renaming the framework would not remove the capture, copying or lifecycle work identified in the measured path.

Do not expand the domain-neutral framework merely to relocate LLM orchestration. Protocol schemas and generic frames can remain pure; request routing scope, background scheduling and execution-result normalization belong in gateway/provider orchestration. For example, B `packages/protocols-llm/src/common/invocation.ts:26` contains routing/credential-related request context, and `common/result.ts:79` contains runtime translation callbacks. These are useful candidates for clearer ownership when their callers are refactored, not a reason to move every type immediately.

The Responses turn is a particularly valuable boundary. B `packages/gateway/src/data-plane/chat-flow/responses/serve.ts:244`, `respond.ts:24` and `session.ts:216` share the same execution result. R HTTP `packages/gateway/src/data-plane/chat/openai-responses/respond.ts:136` and WS `websocket.ts:580` observe and settle events separately. A shorter reference HTTP path does not provide equivalent terminal-tail and cleanup behavior.

Keep upstream-raw and post-translation terminal checks: they protect different producers. Share the reading, cancellation and naturally-exhausted-iterator cleanup machinery where possible, rather than assigning every wrapper its own complete lifecycle manager. The canonical turn must still reconcile output and complete required durable snapshot writes before yielding a successful terminal. The WS session separately publishes connection-local continuation only after native send acceptance and successful turn completion/cleanup (`packages/gateway/src/data-plane/chat-flow/responses/session.ts:235`). Native send acceptance is not a peer acknowledgement.

## 2. Separate immutable routing data from request execution

B `packages/gateway/src/data-plane/providers/registry.ts:288` through `:337` combines initial fetcher construction, catalog acceptance, authoritative fetcher construction, provider creation and full model projection. A provider/fetcher may close over a request dump, signal or credential authority, so caching the resulting object is not a safe substitute for separating its responsibilities.

Use the existing configuration/catalog generations to derive a bounded read-only routing index containing model IDs, capabilities, configuration-derived flags, upstream descriptors and authority/version identifiers. Apply key/owner/pin visibility and request-specific overrides at request time; do not cache an authorization decision across keys or revisions. Construct the fetcher, credential access and mutable invocation for an actual selected attempt. Fallback attempts materialize their own execution state when attempted. Preserve global configuration/preflight failure ordering: lazily constructing a fetcher must not silently defer or suppress errors that currently fail the request before dispatch. Moving such validation to configuration publication requires its own explicit contract.

This should replace repeated projection, not introduce a second full catalog cache. Keep only bounded live generations and no request headers, bodies, AbortControllers or I/O objects in the shared index. An explicit required RoutingScope should express the existing global/owner semantics; it must not silently replace them with Floway's different upstream-whitelist model.

R provides useful contract separation but not a ready-made fast implementation: `packages/gateway/src/data-plane/providers/registry.ts:51` loads upstreams, `packages/gateway/src/repo/sql.ts:885` selects their catalog JSON, and `data-plane/providers/catalog.ts:117` projects the catalog. B's configuration lease and warm memo already avoid much of this work. Retain B `packages/gateway/src/repo/configuration-cache.ts:144` and `data-plane/providers/catalog-coordinator.ts:142`.

For refresh, borrow R `packages/gateway/src/data-plane/providers/models-cache.ts:15`: capture a published snapshot before scheduling its next generation. Its cold path returns an empty catalog rather than waiting for discovery. That is a behavior choice, not a free optimization. Define vNext's cold/expired/unavailable behavior before moving discovery off that path. Keep current D1 CAS/fencing; Floway's execution-cell/DO singleflight still needs SQL CAS and is not sufficient authority on its own.

## 3. Make request and attempt lifetimes explicit

R `packages/gateway/src/data-plane/shared/gateway-ctx.ts:26` explicitly carries request scope, cancellation, background scheduling, dump and attempt observation. B currently threads these through `ResponsesServeArgs`, kit extras, `RequestContext`, telemetry and turn options; `packages/chat-flow-kit/src/serve-template.ts:246` also creates a linked controller. Ambient background, signal, configuration and ingress capabilities have separate scoped accessors.

Prefer four narrow ownership scopes, rather than a universal service container:

| Scope | Owns | Must not retain |
| --- | --- | --- |
| Runtime services | Stable adapters, repos and bounded immutable configuration/catalog views | Request body, request signal, request-bound scheduler |
| Request/turn context | Authorization snapshot, routing scope, source preparation, cancellation owner, scheduler and observation policy | Another request's mutable state |
| Attempt | Selected target, invocation containers, request headers, actual execution identity and upstream resources | Mutable state shared with another retry/target |
| Settlement/prepared storage | Immutable outcome, usage/model identity, completed descriptors and owned bounded storage input | The entire live request graph when only a few fields are needed |

Keep immutable strings shared and mutable attempts isolated. Affinity can represent sparse rewrites over the canonical source input and materialize only at the mutation boundary, following R's ingress/selection pattern. Preserve vNext's actual execution identity, credential/incarnation fencing and owner/key authentication; the original encrypted-block fix depends on those semantics.

An explicit scheduler passed into new execution/observation interfaces is preferable to resolving it deep inside storage code. This is an ownership recommendation, **not a claim of current cross-request scheduler corruption**: B ordinary CFW requests already use `withBackground` in `apps/platform-cloudflare/src/responses-websocket.ts:35`. Both projects still have platform/repo singletons; rewriting all access as dependency injection is unnecessary.

## 4. Normalize results before the turn, without changing upstream mode

B `packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts:185` casts hub-shaped frames to the source result type and attaches `translateBody`/`translateEvents`. Consumers recover the real representation from translator metadata. This makes `responses/turn.ts:374` responsible for both protocol normalization and execution lifetime.

R `packages/gateway/src/data-plane/chat/shared/translate-traverse.ts:50` returns a source event stream directly. Borrow that boundary: an execution-result adapter should own upstream JSON/SSE decoding and target-to-source translation, yielding an explicitly source-shaped result before the canonical turn consumes it. Protocol shape should not be inferred from performance/model identity metadata.

Preserve two important differences:

- JSON body translation can have semantics not reproduced by simply running the SSE translator and collecting it. Keep those mappings and error/status/header contracts explicit.
- R `packages/provider/src/streaming.ts:21` and `packages/provider-custom/src/provider.ts:207` require streaming generation and reject successful non-SSE responses. vNext supports native JSON upstream responses. Do not remove that support to simplify the result union.

The target shape is source-protocol events or a clearly tagged source terminal/body result, with metadata and completion ownership explicit. Stream normalization must remain lazy and demand-driven; it must not buffer a stream merely to simplify the result type. Keep both raw-upstream and source-canonical validation. It is not a new universal lossy protocol or another HTTP SSE encode/decode round trip.

## 5. Treat diagnostics and settlement as distinct contracts

Both projects couple enabled request dumps to upstream HTTP capture. R `packages/gateway/src/dump/http-capture.ts:12` reads the complete request before dispatch, and `:40` retains all response chunks before assembling a snapshot. R `repo/dump-store.ts:184` also writes the third capture file. Its default dump setting is null/disabled; that is not equivalent to B's measured dump-retention zero, which enables its writer.

Keep B's prefix/attempt/aggregate limits (`packages/gateway/src/shared/dump/upstream-attempts.ts:7`) and demand-driven capture. Make the choices explicit in a diagnostic policy: client-facing dump, upstream exchange metadata, upstream body capture, and their budgets. Preserve the present behavior by default until a product-policy change is approved. Changing the policy changes what is recorded; it cannot be presented as a same-feature performance improvement.

Keep the existing ownership progression:

`Capture collector -> immutable bounded snapshot -> codec/prepared input -> file publication -> SQL visibility and independent GC`

Do not return to a publisher that captures the entire raw request record over several storage awaits. B's file adapter can accept streams (`apps/platform-cloudflare/src/r2-file-provider.ts:31`); Floway's R2 wrapper reads complete objects to bytes (`apps/platform-cloudflare/src/r2-file-store.ts:17`). Platform-specific I/O strategies are legitimate while semantics remain shared.

For observation, B `packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts:275` writes legacy performance and the newer metrics projection separately. Existing claim guards prevent duplicate writes, but the compatibility architecture should have an endpoint: one immutable settlement fact should feed usage, current metrics, legacy compatibility and dump metadata. It need not create another durable event table or queue. Some attempt observations settle earlier; request settlement aggregates their facts without overwriting them. Do not delete existing fields or billing/usage semantics to match the reference's narrower metric model.

Correctness persistence and optional diagnostics must retain different failure/timing rules. HTTP response delivery, a reusable continuation commit, and final background settlement are not interchangeable milestones. `waitUntil` keeps work alive; it does not remove CPU cost or transfer execution to a separate memory budget.

## 6. Redesign long-history storage separately

B `packages/gateway/src/data-plane/dispatch/responses-store-bridge.ts:59` and `packages/responses-store/src/sql.ts:88` persist complete input/output history in each snapshot. R `packages/gateway/src/data-plane/chat/openai-responses/items/store.ts:30` separates immutable items and snapshot references; `packages/gateway/src/repo/openai-responses-state-sql.ts:137` enforces item identity/content, and `openai-responses-payload.ts:37` supports compressed inline data and file spill.

Item references can avoid repeatedly persisting the same historical content. They also add hashing, lookups, reference retention, publication and GC costs; they do not eliminate history materialization when an upstream needs the complete conversation. Adopt the data model only with a whole-operation design, not by copying the reference store wholesale.

This is a medium-term stateful-session improvement. The ordinary benchmark disabled Responses snapshot persistence, so this path does not explain its current CPU regression.

The control-plane has a separate large-usage-response problem. Floway's overview endpoint is a useful query-oriented contract, but vNext already evaluated a projection variant and rejected it: [D08 evidence](../2026-09-29-usage-projections-evaluation/README.md) shows smaller output with substantially more HTTP/SQL work. Any new dashboard plan must budget the entire page load and scan count, not just response bytes; it should not be bundled into the inference hot-path refactor.

## 7. Make compatibility part of every architecture change

For catalog publication, affinity carriers, item storage and dump formats, specify all four directions: new readers on old data, old readers on new data, old writers on the new database, and old GC encountering new objects. A migration file or a working new reader proves only part of that matrix.

Keep existing owner/key boundaries, authority checks, old-format readers, file publication fencing and backup/rollback evidence. Resolve the already-open catalog legacy-writer and affinity rollback issues before a CFW rollout. A new routing read model must have a version/generation identity; a new item/sidecar writer must not begin producing incompatible records before its compatible readers and GC are available. Temporary dual writes require an explicit retirement condition and disclosed cost.

## Alternatives and recommended sequence

| Approach | Tradeoff | Recommendation |
| --- | --- | --- |
| Keep architecture unchanged and only remove small allocations | Low change risk, but leaves mixed routing/materialization and implicit result representations | Useful cleanup, insufficient as the complete direction |
| Keep the core, restructure request/routing/result/observation ownership | Addresses repeated work and makes existing guarantees easier to preserve; requires focused seam changes | Recommended |
| Copy the reference runtime, force streaming, add DO/queues or split services | Imports different JSON/WS/capture/cold-start semantics and adds operational boundaries; no measured benefit | Not justified by current evidence |

1. Define explicit request/attempt ownership and a source-shaped result contract; migrate the ordinary Responses path first while HTTP/WS continue to share one turn. Absorb protocol-irrelevant setup and already-identified no-op cleanup into this work.
2. Separate bounded immutable routing projection from request execution materialization, with explicit RoutingScope and existing revocation/version semantics. Preserve cold behavior initially; treat refresh policy changes separately.
3. Consolidate settlement projections and diagnostic policy/codec/publication interfaces. Preserve current enabled-feature defaults and compatibility writes until their migration is complete.
4. Address item-reference history storage and control-plane aggregate loading as separate projects, each with complete-operation cost and rollback design.

For CFW, success means balancing active CPU, shared-isolate memory and client latency. Cloudflare documents a 128 MB per-isolate memory limit, shared across concurrent requests, and distinguishes CPU execution from network waiting ([official limits](https://developers.cloudflare.com/workers/platform/limits/), official documentation source read on 2026-09-30). Additional queues, unbounded body retention or parallel compression can defeat that balance even if a client response returns sooner.

Quantify the complete next implementation batch under the existing semantic/resource gates and unchanged feature settings. This audit adds no tests, profiles, load, deployment or product changes, and does not qualify the current candidate for CFW release.
