# Interceptor contract reference audit

Date: 2026-10-01. Scope: read-only source comparison of interceptor contracts, ordering, private state, provider adaptation, and translation-trip boundaries. No source edits, tests, benchmarks, upstream probes, commits, or deployment were performed for this audit.

## Evidence boundary

- `R` means `/Volumes/Projects/copilot-gateway`, verified clean at `1d7dcd923e260e425120cca0c7a240e93720af27`.
- `F` means `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`, verified HEAD `c3a365511211f709a19207851317587f250740a7`.
- F had existing Responses collaboration source/test changes when inspected. References to its collaboration shim, Responses registry, and Responses attempt describe the observed working tree, not only HEAD. This audit preserves those changes.
- Pointers below are repository-relative paths with line numbers in the inspected files. Findings are source mechanisms; they are not measured production outcomes.

## Recommendation

Adopt the reference's separation of request-only transforms from true around middleware, and make that separation stronger than the reference currently does. The smallest useful implementation is a synchronous `RequestTransform<Req> = (req: Req) => undefined` plus a `beforeRequest` adapter that invokes the next stage once after the transform. Give eligible gateway transforms a narrow payload/flags view; keep action pivots, output mapping, short circuits, provider retries, and server-tool loops on the existing around signature.

Keep every migrated transform at its current array position. This preserves which transforms run once per source request and which rerun inside the hosted-tool loop. Do not replace F's result producer union, independent JSON body adapter, provider response contract, or turn ownership with R's event-only flow.

## What the reference makes explicit

### 1. The runner is deliberately small; protocol bindings supply the useful types

R's runner accepts `Interceptor<Ctx, Env, Result>`, permits short circuiting and repeated `run()`, and recursively wraps entries in declared array order. Its contract says pre-run mutations flow forward and are not restored; callers needing original values must capture them. It explicitly says reviewers, not the framework, enforce that convention (`R/packages/interceptor/src/index.ts:1-47`).

The useful specificity lives above the runner:

- Per-protocol invocations bind concrete request payloads, a readonly selected candidate/target, and mutable headers. Only Responses exposes an action pivot (`R/packages/provider/src/invocation.ts:61-99`).
- Responses binds its chain to `ChatGatewayCtx` and typed Responses frames (`R/packages/gateway/src/data-plane/chat/openai-responses/interceptors/types.ts:29-33`).
- Messages has distinct generation and count-tokens results. Its shared `AnthropicMessagesPayloadInterceptor<TResult>` cannot inspect a particular result shape (`R/packages/gateway/src/data-plane/chat/anthropic-messages/interceptors/types.ts:9-32`).
- Gemini also distinguishes generation from count-tokens results (`R/packages/gateway/src/data-plane/chat/gemini-generate-content/interceptors/types.ts:7-23`).

F's service is already domain-neutral and has the same zero-argument continuation mechanism (`F/vnext/packages/service/src/index.ts:1-44`). Its protocol aliases still share a broad `Invocation` with `Record<string, unknown>` payload and a broad `RequestContext` (`F/vnext/packages/protocols-llm/src/common/invocation.ts:10-87`; `F/vnext/packages/gateway/src/data-plane/chat-flow/shared/interceptor-types.ts:21-24`). Narrowing permissions for request-only transforms is a useful local improvement without a wholesale invocation migration.

### 2. Ordering documents actual semantic dependencies

| Chain | Verified order/dependency | Source |
|---|---|---|
| Responses gateway | Compact pivot outside collaboration namespace; collaboration outside the whole server-tool loop; empty-tools handling inside the loop; canonical transformations before vendor wire normalization | `R/packages/gateway/src/data-plane/chat/openai-responses/interceptors/index.ts:19-69` |
| Chat Completions gateway | Vendor normalizers run last outbound and first inbound, so outer usage transforms see canonical field names | `R/packages/gateway/src/data-plane/chat/openai-chat-completions/interceptors/index.ts:38-64` |
| Messages gateway | Probe may replace the turn; web-search shim wraps request-only transforms; count-tokens shares the payload list in the same order | `R/packages/gateway/src/data-plane/chat/anthropic-messages/interceptors/index.ts:17-64` |
| Gemini gateway | Request cleanups precede the output thought filter | `R/packages/gateway/src/data-plane/chat/gemini-generate-content/interceptors/index.ts:7-29` |
| Copilot Messages | First derive headers from source shape; then mutate wire payload; then derive vision/initiator/beta headers from final wire shape | `R/packages/provider-copilot/src/interceptors/anthropic-messages/index.ts:20-85` |

This is worth adopting as concise dependency documentation and focused order assertions, not a dynamic priority framework. The reference still uses ordinary arrays, with no topological validation or compile-time distinction between an outer loop and a payload normalizer. Type checking alone does not prove these dependencies.

F already has analogous explicit Responses order and appends its provider frame membrane innermost (`F/vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/index.ts:20-82`; `F/vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts:362-370`). Keep those placements. Moving all request transforms into a single global prepass would change repeated-loop behavior.

### 3. Gemini has reusable payload helpers, but not a restricted adapter contract

R already exports synchronous `stripUnsupportedToolsFromPayload` and `stripUnsupportedPartFieldsFromPayload`. Their around wrappers only call the helper and then `run()` (`R/packages/gateway/src/data-plane/chat/gemini-generate-content/interceptors/strip-unsupported-tools.ts:20-38`; `R/packages/gateway/src/data-plane/chat/gemini-generate-content/interceptors/strip-unsupported-part-fields.ts:17-29`). Count-tokens reuses the helpers and inlines safety-settings deletion (`R/packages/gateway/src/data-plane/chat/gemini-generate-content/attempt.ts:87-115`). Safety stripping itself still has a full around signature (`R/packages/gateway/src/data-plane/chat/gemini-generate-content/interceptors/strip-safety-settings.ts:8-10`).

That is a direct precedent for the proposed F slice. A synchronous adapter can remove unnecessary continuation/result access, whereas R's result-polymorphic Messages alias still exposes `run` and environment and can short circuit by throwing or invoke `run` repeatedly. Returning `undefined` rather than using the permissive callback return type `void` also allows TypeScript to reject an accidental async transform at this boundary.

F already has the Gemini tools helper (`F/vnext/packages/gateway/src/data-plane/chat-flow/gemini/interceptors/strip-unsupported-tools.ts:53-68`). Preserve its existing behavior: F retains `googleSearch` and `googleSearchRetrieval` (same file, `:3-15,48-51`), while R removes them (`R/packages/gateway/src/data-plane/chat/gemini-generate-content/interceptors/strip-unsupported-tools.ts:9-18`). Borrow the contract, not those field deletions.

An adjacent comment is stale: F's Gemini registry says count-tokens applies the payload mutators inline (`F/vnext/packages/gateway/src/data-plane/chat-flow/gemini/interceptors/index.ts:9-12`), but the inspected `gemini/count-tokens.ts:42-43` directly calls `translateGeminiToMessages` and does not import or call these helper exports. This is not evidence that count-tokens is broken; it means this refactor should not silently add new count-tokens mutations to match the comment.

### 4. The reference keeps provider adaptation inside provider calls

Copilot declares concrete boundary contexts with protocol payload, headers, provider model, and protocol-specific metadata (`R/packages/provider-copilot/src/interceptors/openai-responses/types.ts:11-27`; `anthropic-messages/types.ts:19-39`; `openai-chat-completions/types.ts:8-18`). `provider.ts` creates those contexts, runs the provider-owned chain, and switches the Responses terminal on the post-chain action (`R/packages/provider-copilot/src/provider.ts:344-418,455-484`). Gateway code calls the typed provider operation rather than importing the Copilot workaround list.

Mechanism benefit: vendor decisions and wire/header dependencies have a clear owner; the gateway needs fewer provider-specific branches.

F cannot copy this placement mechanically. Its provider returns raw `ProviderResponse`, so Copilot's item-id membrane operates on parsed frames through a provider-declared gateway interceptor (`F/vnext/packages/provider-copilot/src/provider.ts:92-102`; `F/vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts:362-370`). The byte-level provider chain already exists independently (`F/vnext/packages/provider-copilot/src/provider.ts:193-218`). Preserve both seams in this slice. Moving frame handling into `fetch` would be a provider/result redesign, not merely a contract improvement.

### 5. Private state has distinct lifetimes

R uses three useful ownership patterns:

1. **One interceptor invocation:** collaboration alias, recognized names, and the response restorer are locals captured by the output iterator (`R/packages/gateway/src/data-plane/chat/openai-responses/interceptors/collaboration-shim.ts:326-364`). They do not live on generic invocation metadata.
2. **One translation trip:** `TranslateTrip` returns target payload and a reverse event closure; synthetic IDs and tool-name maps stay captured by that closure (`R/packages/translate/src/types.ts:10-25,52-75`; `openai-responses-via-anthropic-messages/translate.ts:8-29`).
3. **Source-owned replay/private payloads:** every chat context carries a store; native Responses can persist, while non-Responses sources use a store without backings (`R/packages/gateway/src/data-plane/chat/shared/gateway-ctx.ts:7-34`; `openai-responses/items/store.ts:390-397`). `beginAttempt` clears and reseeds the transient private-payload map, with registration/get operations separate from request payloads (`store.ts:30-54,160-170`). Responses attempt explicitly leaves source hydration, affinity, and persistence to the native source edge (`openai-responses/attempt.ts:76-105`).

F's local collaboration closure follows pattern 1 already (`F/vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/with-responses-collaboration-shim.ts:338-381`, working tree). Its hosted-tool private payload store is process-wide by default, with TTL expiry and sweep-on-write, and the registry captures that singleton (`F/vnext/packages/gateway/src/data-plane/orchestrator/server-tools/private-payload-store.ts:21-68`; `F/vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/index.ts:76`). It is not a request-owned store despite the nearby shim comment. TTL does not establish a maximum entry count or byte bound; inactive stale entries can remain until another write or lookup touches them. This is a real ownership difference, not measured evidence of a leak or cross-request disclosure.

A later, separate private-state slice could introduce an explicitly request/attempt-owned scratchpad injected at the existing turn owner, with a documented replay seed/reset rule. Do not merge that change into the request-transform adapter. Preserve native Responses hydration/persistence and keep synthesized tool payloads private. Do not transplant R's structured cloning on each store read/write without a resource reason; it copies private payloads and has no measured CFW advantage here.

### 6. Translation-trip ownership is useful; its event-only result model is not F's model

R's translation package is runtime-independent: pair-specific context extras receive capabilities/adapters, and a pair may optionally rewrite an upstream error using bare HTTP primitives (`R/packages/translate/src/types.ts:10-75`). Traversal invokes a trip, calls the target attempt, and maps target events back into source events (`R/packages/gateway/src/data-plane/chat/shared/translate-traverse.ts:50-76`). Target attempts re-enter the target protocol's own interceptor chain (`R/packages/gateway/src/data-plane/chat/openai-responses/attempt.ts:167-199`; `openai-chat-completions/attempt.ts:54-76`).

F intentionally leaves the result stream in its producer protocol until the response boundary chooses either the independent JSON body adapter or event adapter (`F/vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts:5-22,143-206`). Its discriminated native/translated result union and runtime validation make the producer domain independent of telemetry (`F/vnext/packages/protocols-llm/src/common/result.ts:110-152`). `materializeResponsesSource` is reserved for interceptors that actually consume source events; stream-only mapping retains the JSON adapter (`F/vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptor-source.ts:11-48`).

Adopt pair-scoped dependency and private-state ownership where useful, but keep F's producer/result model. Eagerly adopting R's `events: trip.events(inner.events)` would change F's JSON path and can lose body-only semantics. Request-only normalizers should never read or alter any producer, translator, stream, final-metadata, or disposal field.

## Proposed lightweight contract and guardrails

1. **Add a domain-neutral synchronous transform and a trivial adapter.** `beforeRequest` alone owns delegation and returns the exact downstream result. A throw stops dispatch and propagates into the existing attempt error boundary. Keep the existing around runner available; do not impose a global once-only `next`, because the hosted-tool loop intentionally calls it for later turns (`R/packages/gateway/src/data-plane/chat/openai-responses/interceptors/server-tool-shim.ts:980-1009`; `F/vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-shim.ts:1195-1229`).
2. **Expose only fields each migrated transform needs.** A payload/readonly-flags view is sufficient for the initial simple normalizers. If a future transform genuinely needs source or selected-target gating, add a narrow read-only field or leave it on its current contract rather than expanding every request-only view. Do not grant `headers`, `action`, abort, auth, telemetry, private store, or result access to transforms that do not use them.
3. **Preserve payload replacement.** F normalizers such as `with-empty-tools-tool-choice-none.ts:3-8` and `with-role-compatibility-applied.ts:20-58` replace `inv.payload`. A temporary `{ payload: inv.payload }` view must explicitly propagate the resulting payload reference back before delegation. Alternatively use a narrow type view of the same invocation or a controlled accessor. Do not silently turn replacement into an ignored assignment. Keep extra-field preservation and existing validation behavior.
4. **Preserve per-call reads and existing order.** Construct/read the view when the adapter executes, not when the registry is built. A hosted-tool loop changes payload and invokes the inner chain again. Do not move transforms across compact/collaboration/tool-loop boundaries, and do not precompute payload references across calls.
5. **Leave retry ownership intact.** Copilot auth recovery retries only the terminal, explicitly avoiding replay of in-place transforms (`F/vnext/packages/provider-copilot/src/provider.ts:228-234`). The adapter should neither retry nor restore shared invocation state. A candidate retry and a tool-loop iteration are different owners and must retain their current behavior.
6. **Start with already-pure request normalizers.** Gemini payload helpers and simple empty-tools/cache-key/role/reasoning normalizers are candidates after checking exact reads. Keep `suppressThoughtParts`, usage/vendor output normalization, compact simulation, collaboration restoration, and server-tool shims as around middleware. Their request halves are not sufficient evidence that the whole function is request-only.

Meaningful validation for an implementation would establish: transform-before-terminal and exactly one delegation; thrown-transform skips terminal; identical downstream result object/provenance; replacement payload observed by later stages; correct repeated execution under a loop; existing Gemini search-tool preservation; and source JSON/SSE paths remain unchanged. Compile-time fixtures should reject async transforms and accidental context/result access. This audit did not run those checks.

## Benefits and remaining limits

The narrow transform contract provides compile-time misuse prevention, easier local review, and explicit ownership of delegation. It makes it harder for a payload normalizer to consume a stream, corrupt producer metadata, retry a provider, or accidentally skip the next stage. R's typed invocations, dependency comments, and closure-owned state are valuable reference mechanisms.

Neither R nor the proposed adapter proves global interceptor order, deep immutability, retry idempotence, safe concurrent repeated continuation calls, or private-state size limits. R's runner explicitly leaves mutation enforcement to review; its readonly candidate/header properties do not deeply freeze objects. R's Responses attempt clones the payload, whereas Chat Completions starts with a shallow copy (`R/packages/gateway/src/data-plane/chat/openai-responses/attempt.ts:88`; `R/packages/gateway/src/data-plane/chat/openai-chat-completions/attempt.ts:33`), so there is no uniform copy/rollback guarantee to import.

No latency, CPU, allocation, peak-memory, or CFW-limit improvement was measured. A synchronous request transform can keep work bounded to existing payload operations and avoid introducing result wrappers, frame copies, buffers, deep clones, or per-request graph validation. A view/adapter may add a small allocation or closure depending on implementation. Claims should remain correctness/maintainability claims unless a representative measurement establishes a resource change.

## Focused review of the implementation design

Reviewed `F/vnext/docs/superpowers/specs/2026-10-01-interceptor-contracts.md` and the same-named file under `plans/`. No blocking design issue found. The reference advantages are accurately described. The chosen same-Invocation `Pick<Invocation, "payload" | "enabledFlags">` view preserves payload replacement without a temporary object. A normal function that catches synchronous exceptions and otherwise returns `next()` directly preserves the downstream promise on the success path; the existing async chain runner already exposes synchronous failures as rejected promises to callers.

All 21 modules listed in plan Task 2 were individually read: seven Responses, five Messages, six Chat Completions, and three Gemini entries. Their current bodies perform synchronous payload/flag work and do not inspect the downstream result, ambient context, action, or headers. Responses DeepSeek/Qwen and Chat Qwen are outbound-only in F, so they fit despite the broader vendor-normalizer category sometimes having output duties. The listed exclusions retain the genuine output/orchestration owners. Keeping each module's export and array position is appropriate.

The narrowed view is an API restriction for trusted TypeScript code, as the spec states; it is not runtime access isolation or proof against a function launching detached work indirectly. Per-entry delegation remains distinct from the outer loop's legitimate repeated entries. No additional runtime enforcement, deep copy, or global once-only continuation check is recommended for this batch. Implementation and type-check evidence are still required before calling the change complete.
