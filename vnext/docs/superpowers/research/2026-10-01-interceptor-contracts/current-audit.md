# Current interceptor contract audit

Date: 2026-10-01. Read-only source review of worktree `cfw-resource-rollback-fix`, HEAD `c3a365511211f709a19207851317587f250740a7`, including the existing dirty overlay. No source edits or tests were performed. References below are relative to `vnext/`; line numbers describe the inspected snapshot.

## Recommendation

Introduce one domain-neutral, synchronous request-transform contract in `@vibe-core/service`, adapt it to the existing around-interceptor shape, and migrate the 21 gateway interceptors that only synchronously modify payloads. Use an explicit `undefined` return contract rather than `void`: TypeScript permits an async/value-returning callback where a void-returning callback is expected. Give those transforms only a gateway-owned `Pick<Invocation, "payload" | "enabledFlags">` view. None of the 21 candidates needs `RequestContext`, headers, action, endpoint, source protocol, a result, or `next`.

Keep existing exported interceptor names, array positions, `runInterceptors`, and attempt wiring. The adapter owns exactly one downstream call after a successful synchronous transform, propagates its result/error untouched, and runs once each time its chain position is entered. It must preserve the shared Invocation object's identity, including replacement of `inv.payload`; copying a narrow view would lose replacement writes unless an unnecessary setter membrane were introduced. This is a compile-time capability boundary, not a runtime security sandbox or deep immutability guarantee.

The material benefit is that a payload normalizer cannot accidentally skip dispatch, dispatch twice, inspect/replace an event producer, or suspend before dispatch through its declared interface. The proposal adds no per-frame validation, cloning, global registry, runtime dependency metadata, or protocol behavior. Existing around interceptors retain intentional short-circuiting, tool-loop re-entry, result wrapping, and asynchronous work.

Do not touch the protected dirty Responses registry, attempt, collaboration shim, shared attempt helper, protocol package overlay, or their dirty/untracked tests for this slice. The existing registry can continue importing the same exported names from migrated leaf modules.

## Actual composition and shared-state contract

- `packages/service/src/index.ts:11-15,33-43`: every interceptor currently receives the same `req`, same `ctx`, and an unrestricted zero-argument `next`. The array's first entry is outermost. There is no once guard, restoration, cloning, cancellation, or producer ownership in this generic runner. `next` recursively enters the suffix again; sequential multiple calls are intentional. Concurrent calls sharing mutable Invocation state are not shown to be safe by this implementation and should not be newly promised.
- `packages/protocols-llm/src/common/invocation.ts:10-57`: `payload`, `headers`, and `action` are writable. Endpoint, flags, source API, and request context fields are readonly at the type level. Payload normalizers mix object replacement and in-place mutation, so a transform contract must support both. Context is read-only capability access, not a scratch-state bag.
- `packages/gateway/src/data-plane/chat-flow/messages/attempt.ts:329-387` and `chat-completions/attempt.ts:125-176`: when the chosen target differs, the source attempt returns through `traverseTranslation` before constructing/running its native registry. The target attempt runs its registry. These registries are principally target-protocol chains.
- `responses/attempt.ts:347-421`: Responses deliberately wraps cross-protocol traversal inside its terminal. Its source chain runs even when the chosen hub is Messages or Chat; the hub then runs its native chain. Provider-declared Responses interceptors are appended innermost at lines 362-370.
- `gemini/attempt.ts:168-225`: Gemini has no identity target. Its source payload cleanups and post-translation filter always surround traversal into a hub attempt. `Invocation.endpoint` is the selected hub even while its payload remains Gemini-shaped. Do not infer payload protocol from `endpoint` across all four chains.
- Native terminals read the current `invocation.payload` and headers on every invocation (`responses/attempt.ts:424-439`, `messages/attempt.ts:393-410`, `chat-completions/attempt.ts:185-210`). Moving transforms outside the chain would change later tool turns.

## Inventory: Responses

Production order is `responses/interceptors/index.ts:70-82`; the collaboration entry is part of the protected overlay. All leaf paths in this table are under `packages/gateway/src/data-plane/chat-flow/responses/interceptors/`.

| Interceptor | Reads / writes / result behavior | Contract classification and order |
| --- | --- | --- |
| `withResponsesCompactShim` | Expands owned compaction history; reads flags, `action`, input, `ctx.targetEndpoint`; rewrites input/store and pivots `action` to generate. Consumes a complete source result and synthesizes a compaction result; invokes `registerPlaintextCompaction`. | Around, one `next`; outermost before all payload changes. Source materialization required on translated results. See `with-responses-compact-shim.ts:212-324`. |
| `withResponsesCollaborationShim` | Reads tool inventories/history/choice and flags; rewrites tools/choice/input to one request-local alias. Wraps source event translation and JSON body translation to restore client namespace; tracks per-request call identities. | Around, one `next`; must wrap the entire server-tool loop so the alias is allocated once. Protected overlay, `with-responses-collaboration-shim.ts:338-381`. |
| `withToolArgumentWhitespaceAborted` | No payload mutation; tracks source argument deltas by output index, emits error+done and ends early on overflow. | Around; `mapResponsesSourceFrames` preserves translated producer/body ownership. Outside hosted loop, sees client-facing merged source events. `with-tool-argument-whitespace-aborted.ts:38-70`. |
| `withPromptCacheKeyStripped` | Flags + payload; removes top-level `prompt_cache_key` by payload replacement. | Synchronous transform candidate. Outside hosted loop; removal persists in later payloads. `with-prompt-cache-key-stripped.ts:10-16`. |
| `withImageGenerationToolInjected` | Flags, tools, tool choice; adds hosted image tool unless disabled/already declared. | Synchronous transform candidate. Must precede hosted-tool preparation. `with-image-generation-tool-injected.ts:33-43`. |
| `withResponsesServerToolShim` | Async registrations read source/flags/payload plus dump, caller key, incoming model, binding scope, signal. Rewrites hosted tools, include tokens, tool choice and replay input. Consumes each turn, executes tools, replaces payload for continuation, merges output/usage, tracks latest identity and resolves final metadata. | Around, zero or multiple sequential `next` calls, most after result iteration begins. `server-tool-shim.ts:957-1237`. |
| `withEmptyToolsToolChoiceNone` | Flags, tools; sets `tool_choice: 'none'` for an explicit empty tools array. | Synchronous transform candidate, inside hosted loop. `with-empty-tools-tool-choice-none.ts:3-8`. |
| `withRoleCompatibilityApplied` | Flags + input; maps message roles with promotion/demotion/interleaved rules. | Synchronous transform candidate, inside loop, before vendor wire normalization. `with-role-compatibility-applied.ts:20-58`. |
| `withReasoningDisabledOnForcedToolChoice` | Flags + choice; writes canonical `reasoning: { effort: 'none' }`. | Synchronous transform candidate, inside loop, before vendor sentinel consumers. `with-reasoning-disabled-on-forced-tool-choice.ts:27-36`. |
| `withVendorDeepSeekResponsesNormalize` | Flags + reasoning; converts sentinel to `thinking: { type: 'disabled' }` and removes reasoning. | Synchronous transform candidate; outbound only, final shared-wire stage. `with-vendor-deepseek-normalized.ts:21-35`. |
| `withVendorQwenResponsesNormalize` | Flags + reasoning; converts sentinel to `enable_thinking: false` and removes reasoning. | Synchronous transform candidate; outbound only, final shared-wire stage. `with-vendor-qwen-normalized.ts:16-30`. |

The provider-specific Copilot item-ID membrane is separate and remains around: it restores inbound item IDs, then normalizes native upstream Responses frames; translated results pass through. See `packages/provider-copilot/src/interceptors/responses/with-item-id-membrane.ts:293-305`. Its provider-owned declaration and innermost append ensure it never normalizes synthesized hosted-tool/compaction output. `packages/provider-llm/src/types.ts:144-160` explains the runtime reason: provider fetch is byte-level; frame parsing is gateway-owned. This is a valid boundary based on actual runtime ownership, not a candidate for moving all frame processing into providers.

## Inventory: Messages

Order: `packages/gateway/src/data-plane/chat-flow/messages/interceptors/index.ts:49-59`. Leaf paths below are in that directory.

| Interceptor | Reads / writes / result behavior | Contract classification and order |
| --- | --- | --- |
| `withContextWindowErrorRewritten` | Reads returned upstream-error bytes; replaces status/headers/body with canonical Messages context-length error. | Around, result-only; outermost. `with-context-window-error-rewritten.ts:35-48`. |
| `withSpeedFast` | Pass-through, deliberately preserves hint for provider dispatch. | Leave existing no-op export; no useful migration. `with-speed-fast.ts:3-5`. |
| `withThinkingDisplayPromoted` | Captures model/thinking display before `next`; mutates `thinking.display`; wraps native frames to remove thinking text while preserving signatures. | Around, both request and response. Captured original intent must survive downstream changes. `with-thinking-display-promoted.ts:124-152`. |
| `withBillingAttributionStripped` | Flags + system; mutates/deletes system and maps blocks. | Synchronous transform candidate. Outside search shim so its captured base is clean. `with-billing-attribution-stripped.ts:49-74`. |
| `withEagerInputStreamingStripped` | Flags + tools; replaces tools array without eager-input fields. | Synchronous transform candidate. Outside search shim. `with-eager-input-streaming-stripped.ts:22-31`. |
| `withMessagesWebSearchShim` | Captures base payload; rewrites tools/history, resolves key-scoped engine asynchronously, wraps native events. Reads `sourceApi` to either expose native `pause_turn` or drive continuation. | Around, can short-circuit invalid input; multi-next for non-Messages clients. `with-messages-web-search-shim.ts:1073-1108,1177-1218`. |
| `withEmptyToolsToolChoiceNone` | Flags + tools; writes native `tool_choice: { type: 'none' }`. | Synchronous transform candidate, reruns inside loop. `with-empty-tools-tool-choice-none.ts:3-8`. |
| `withRoleCompatibilityApplied` | Flags + messages; maps every message-level system role to user. | Synchronous transform candidate, reruns inside loop. Actual code maps all such messages; the stale leading-run wording is not an additional behavior. `with-role-compatibility-applied.ts:20-36`. |
| `withReasoningDisabledOnForcedToolChoice` | Flags + choice/output config; disables thinking, strips only effort, preserves structured-output format. | Synchronous transform candidate, reruns inside loop. `with-reasoning-disabled-on-forced-tool-choice.ts:26-46`. |

Search continuations re-prepare native tools/messages from the captured base, retaining scalar fields from the most recently mutated Invocation. Only the chain suffix reruns. Billing/eager-input transforms must therefore remain outside where they currently sit; a global preprocess phase would not express the same lifetime automatically.

## Inventory: Chat Completions

Order: `packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/index.ts:57-69`. Leaf paths below are in that directory.

| Interceptor | Reads / writes / result behavior | Contract classification and order |
| --- | --- | --- |
| `withChatCompletionsWebSearchShim` | Reads flags/options/tools/key/signal; asynchronously resolves engine, removes options, injects a function tool, executes searches, appends messages, merges usage/citations and client tool calls. | Around, outermost; zero/multiple `next`. `with-chat-completions-web-search-shim.ts:159-234,256-385`. |
| `withEmptyToolsToolChoiceNone` | Flags + tools; writes `tool_choice: 'none'`. | Synchronous transform candidate; after shim injection, every loop turn. `with-empty-tools-tool-choice-none.ts:3-8`. |
| `withUsageStreamOptionsIncluded` | Streaming flag + existing stream options; mutates `include_usage: true`. | Synchronous transform candidate, every loop turn; original client intent is retained elsewhere. `include-usage-stream-options.ts:19-25`. |
| `withToolArgumentWhitespaceAborted` | No payload mutation; native frame argument whitespace tracking, throws on overflow. | Around, one wrapper per loop turn; native producer assertion. `with-tool-argument-whitespace-aborted.ts:51-73`. |
| `withPromptCacheKeyStripped` | Flags + payload; removes cache key by replacement. | Synchronous transform candidate, every loop turn. `with-prompt-cache-key-stripped.ts:11-17`. |
| `withRoleCompatibilityApplied` | Flags + messages; maps promotion/demotion/interleaved roles. | Synchronous transform candidate, canonical shape before vendors. `with-role-compatibility-applied.ts:24-56`. |
| `withReasoningDisabledOnForcedToolChoice` | Flags + choice; writes `reasoning_effort: 'none'`. | Synchronous transform candidate, before vendor sentinel consumer. `with-reasoning-disabled-on-forced-tool-choice.ts:27-36`. |
| `withVendorDeepSeekChatCompletionsNormalize` | Rewrites reasoning sentinel/JSON schema outbound, remaps cache usage inbound. | Around, bidirectional; do not migrate whole interceptor as a pure transform. `with-vendor-deepseek-normalized.ts:63-88`. |
| `withVendorQwenChatCompletionsNormalize` | Flags + sentinel; writes `enable_thinking: false` and removes sentinel. | Synchronous transform candidate; outbound only. `with-vendor-qwen-normalized.ts:12-25`. |
| `withVendorKimiChatCompletionsNormalize` | Flags + native usage; normalizes cached-token field. | Around, result-only. `with-vendor-kimi-normalized.ts:33-56`. |
| `withReasoningContentDialect` | Flags + historical reasoning; changes outbound message fields, then native delta fields inbound. | Around, bidirectional; innermost lets the search loop see canonical events and reruns history normalization. `with-reasoning-content-dialect.ts:90-113`. |

The loop explicitly relies on shared mutable Invocation and repeatable suffix execution (`with-chat-completions-web-search-shim.ts:20-27`). A generic once-only guard would break it. Moving the request normalizers outside the shim would skip the grown history and later turn normalization.

## Inventory: Gemini

Order: `packages/gateway/src/data-plane/chat-flow/gemini/interceptors/index.ts:20-25`. Leaf paths below are in that directory.

| Interceptor | Reads / writes / result behavior | Contract classification |
| --- | --- | --- |
| `stripUnsupportedPartFields` | Mutates nested contents/system parts; removes unsupported fields and empty parts. | Synchronous transform candidate, payload-only. `strip-unsupported-part-fields.ts:30-49`. |
| `stripUnsupportedTools` | Mutates nested tool groups, filters unsupported groups, deletes empty tools. | Synchronous transform candidate, payload-only. `strip-unsupported-tools.ts:39-68`. |
| `stripSafetySettings` | Deletes safety settings. | Synchronous transform candidate, payload-only. `strip-safety-settings.ts:11-14`. |
| `suppressThoughtParts` | Reads caller includeThoughts after `next`; wraps both translated event and body adapters. | Around, result adaptation; must filter Gemini source outputs after hub translation. `suppress-thought-parts.ts:85-110`. |

## Lifetime, cancellation, and producer domains

1. A resolved around call does not imply a completed request. The three hosted-tool loops keep `Invocation`, `run`, and their local state alive inside lazy generators. Their later `next` calls happen after `attempt.generate` returned. The attempt's outer catch only handles pre-return failures, not arbitrary failures during later iteration; comments attributing every lazy-loop failure to attempt catch are broader than the control flow.
2. Native attempts attach a body-specific `discardProducer` callback when creating results (`responses/attempt.ts:499-507`, `messages/attempt.ts:456-464`, `chat-completions/attempt.ts:253-261`). Capturing the concrete body avoids the mutable multi-turn `upstreamResp` variable. Before iteration, closing an unstarted async generator alone cannot guarantee body release. `shared/producer-ownership.ts:6-38` aborts/disposes/closes rejected results with bounded disposal.
3. During consumption, native telemetry's finally disposes its tail and closes the underlying iterator; cancellation is also settled for explicit return (`shared/upstream-telemetry.ts:70-177`). `shared/stream-tail.ts:87-106` bounds iterator close and metadata settling. For-await wrappers preserve normal return propagation; a replacement that abandons a result owns explicit disposal. The generic service runner does not own that lifecycle.
4. Responses hosted tools pass downstream cancellation into their request context; Chat search places it in the execution session. The inspected Messages search shim does not explicitly thread a downstream signal into its search-provider object. This is a static difference to assess separately, not a proven leak and not required for the transform slice.
5. `LlmEventResult` discriminates native source frames from translated hub frames independently of telemetry (`packages/protocols-llm/src/common/result.ts:81-152`). `traverseTranslation` retains hub events and independent JSON/event adapters; it rejects nested translated producers and propagates disposal (`shared/traverse-translation.ts:143-205`). Never select a collector from mutable `modelIdentity.translatorPair` or cast hub frames to source frames.
6. Responses source-aware helpers are the valid boundary: `responses/interceptor-source.ts:12-33` materializes source events only for consumers such as compact/server-tool shims; lines 36-48 wrap source event translation without consuming hub events or replacing the independent JSON body adapter. The collaboration overlay separately wraps JSON restoration. Native Messages/Chat stream interceptors use `requireNativeEventResult`; pure request transforms should gain no producer/result capability.
7. Responses hosted loops publish replacement provenance and `finalMetadata`, resolved in their generator's finally (`server-tool-shim.ts:1084-1095,1216-1237`). Chat/Messages search wrappers retain the initial result metadata while summing event usage. This existing distinction must not be accidentally homogenized by the request-transform slice.

## Bounded validation for the proposed slice

Existing tests provide useful mechanisms but not complete current registry-order proof:

- `packages/service/src/__tests__/run-interceptors.test.ts:18-65` covers nesting and short-circuiting; `packages/gateway/tests/interceptors.test.ts` also covers visible shared payload writes. Add adapter-level assertions for sync mutation before terminal, payload replacement, unchanged result identity/errors, thrown transform preventing dispatch, and intentional repeated suffix execution against the same request.
- Add a compile-time negative check that async transforms, result-returning transforms, and access to `headers`/`action`/`next` are rejected. Prefer a small type-level assertion or the repository's documented compiler-fixture mechanism, not an undocumented suppression.
- Existing leaf behavior tests remain callable through unchanged interceptor exports. `chat-completions/interceptors/include-usage-stream-options.test.ts:77` already runs a production chain to inspect terminal payload.
- Reuse existing fixture style for a few production-array behavior tests: forced choice produces vendor-disabled reasoning before terminal; image injection is visible to hosted preparation; a hosted continuation re-enters inner transforms with grown payload and preserves outer one-time preparation. These assertions fail on meaningful reordering without asserting every incidental array position.
- Existing multi-turn fixtures include Chat search (`with-chat-completions-web-search-shim.test.ts:232,270,298`), Responses identity across two turns (`server-tool-shim.test.ts:573`), and source/JSON translation exactly once (`responses/interceptors/producer-domain.test.ts:66`). The dirty collaboration fixtures additionally cover one alias across a real hosted loop; preserve them.

Keep validation local to contracts and behavior. A production metadata engine that declares every read/write/order relationship would impose a new registry/lifetime model without solving a demonstrated runtime need. The type adapter plus selected composition tests enforces this bounded contract at the existing runtime boundaries.
