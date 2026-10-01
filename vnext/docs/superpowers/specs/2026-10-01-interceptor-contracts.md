# Interceptor contracts derived from actual responsibilities

## Intent and source evidence

Continue the reference-led architecture work at local `vNext` baseline `c3a365511211f709a19207851317587f250740a7`, with the preserved collaboration overlay. The user has authorized implementation, review and local vNext integration. No push or deployment is part of this batch.

Reference evidence is `/Volumes/Projects/copilot-gateway` at `1d7dcd923e260e425120cca0c7a240e93720af27`. Its useful mechanisms are:

| Reference mechanism | Advantage | Adoption here |
| --- | --- | --- |
| Gemini `strip-unsupported-tools.ts` and `strip-unsupported-part-fields.ts` expose synchronous payload helpers | Payload transformation can be understood and reused without stream or orchestration control | Give all genuinely synchronous request-only corrections a narrower callback contract, retaining existing transformation semantics |
| Messages `AnthropicMessagesPayloadInterceptor<TResult>` separates payload logic from a concrete result type | Request corrections do not need to inspect protocol output | Go further for the demonstrated subset: do not supply result, context or `next` to the normalizer |
| Typed gateway/attempt contexts make scope and dependencies visible | Authority and lifetime are explicit inputs | Normalizers receive a typed view containing only mutable `payload` and readonly `enabledFlags`; preserve the original invocation identity |
| Ordered chains keep tool orchestration outside per-turn wire corrections | Every tool iteration sees required outbound normalization and canonical inbound output | Keep every existing chain position; use behavioral composition tests for selected real dependencies |

The reference still gives these around-interceptors `run` and shared mutable state. It does not enforce single downstream invocation for payload-only transforms. This batch adopts its separation strengths while tightening that missing contract. Reference Gemini tool filtering also differs from vNext: vNext intentionally preserves `googleSearch` and `googleSearchRetrieval`. Copy the separation mechanism, not the differing payload rules.

## Actual extension responsibilities

| Role | Mutation and result authority | Lifetime / execution |
| --- | --- | --- |
| Synchronous request correction | May mutate or replace the current invocation payload using its enabled flags; no access through this callback to context, headers, action, result or `next` | Runs once per chain entry; no async or detached work |
| Request/action orchestration | May pivot semantic action, construct tool turns, invoke downstream repeatedly or short-circuit | Existing compact/tool-loop owner remains responsible for call-local state and cancellation |
| Bidirectional adaptation | Shapes the wire request and transforms the corresponding returned JSON/events | Keep state local to that invocation; preserve producer-domain checks and original stream ownership |
| Result transformation / observation | Reads or replaces a returned event source, may detect failures or abort upstream | Retain stream cancellation, cleanup and terminal semantics; not a request-only normalizer |
| Provider wire adaptation | Applies selected-provider knowledge at the innermost provider boundary | Existing provider declaration and attempt placement remain authoritative |

These roles are not contiguous universal phases. Responses runs translation inside its terminal; Messages and Chat Completions cross-target requests bypass their native source registry and enter the selected target chain; Gemini performs source cleanup before traversing its hub. Moving all normalizers before routing would change behavior. Keep native JSON, source/producer domains and each endpoint's existing placement.

## Selected implementation

### Domain-neutral synchronous contract

In `@vibe-core/service`, add:

```ts
export type RequestTransform<Req> = (req: Req) => undefined

export function beforeRequest<Ctx, Req, Result>(
  transform: RequestTransform<Req>,
): Interceptor<Ctx, Req, Result>
```

The adapter supplies exactly the original request to the transform. After successful synchronous completion it calls `next()` exactly once per entry, returning its exact promise without an extra async wrapper. A thrown transform stops downstream execution; a thrown transform or synchronous downstream throw becomes a rejected promise with the original error. Existing downstream rejection and result identity are preserved. An outer orchestration interceptor may enter the adapter repeatedly; each entry performs the transform anew on the same invocation, including payload replacement made by an earlier turn.

Use `undefined` rather than `void` so TypeScript rejects asynchronous callbacks instead of silently discarding a returned promise. This is an API contract for trusted implementation code, not a runtime security sandbox. Do not add runtime result inspection, request clones, registry scans or new global state.

### Gateway capability view

In `chat-flow/shared/request-normalization.ts`, add:

```ts
export type RequestNormalizationInput = Pick<Invocation, "payload" | "enabledFlags">
export type LlmRequestNormalizer = RequestTransform<RequestNormalizationInput>

export function withRequestNormalization<TResult>(
  normalize: LlmRequestNormalizer,
): LlmInterceptor<TResult>
```

Delegate to `beforeRequest<RequestContext, Invocation, TResult>`. The actual argument remains the original invocation with a narrower parameter type. Do not create `{ payload: invocation.payload }`: replacing that temporary view's payload would fail to update the request consumed by the terminal. No copy, getter/setter proxy, deep freeze or auth access is required.

### Migrate only the verified 21 request-only interceptors

Preserve exported names, protocol interceptor result signatures and registry positions. Their existing payload mutations and flag gates move unchanged into synchronous callbacks. Keep existing Gemini payload helpers and current Gemini search-field preservation.

- Responses (7): empty-tools tool choice, forced-tool reasoning, roles, prompt-cache removal, image-tool injection, DeepSeek outbound normalization, Qwen outbound normalization.
- Messages (5): empty-tools tool choice, forced-tool reasoning, roles, billing-attribution removal, eager-input-streaming removal.
- Chat Completions (6): empty-tools tool choice, usage stream options, forced-tool reasoning, roles, prompt-cache removal, Qwen outbound normalization.
- Gemini (3): unsupported part fields, unsupported tools, safety settings.

Keep all around-interceptors with actual output/orchestration duties unchanged, including Chat DeepSeek, Kimi, reasoning dialect, whitespace guards, thinking display, thought filtering, compact/collaboration and hosted tools. Keep the no-op speed hint unchanged. Existing registry comments about Gemini count-tokens cleanup do not match its current direct translation path; record that discrepancy without altering count-tokens behavior in this batch.

## Compatibility, costs and preservation

- Reuse `.worktrees/cfw-resource-rollback-fix` and installed dependencies. No push, CFW deployment, Docker replacement, service restart, dependency installation or production access.
- Preserve all original tracked/untracked overlay bytes. None of the 14 isolated protected paths needs modification; do not stage them.
- Preserve chain order, tool-loop reentry, native JSON, producer-domain checks, provider placement, flags, payload rules, quota/history ordering, Responses continuation and cleanup authority.
- Keep the service package domain-neutral and the gateway wrapper typed. No `any`, suppression directives or new non-null assertions. Source/docs remain English; user updates Chinese.
- Construct adapter closures once when modules initialize. Each chain entry adds one synchronous function call; successful delegation creates no extra promise or per-frame work. These mechanisms do not prove a CPU/latency/heap improvement.
- No new schemas, environment variables, feature flags, retry policies or lifecycle owners.
- Use focused validation during implementation and one final `ci:local` qualification of the frozen artifact. Do not run benchmarks in this slice.

## Acceptance and subsequent work

Tests demonstrate original request and downstream promise/result identity; successful normalization delegates once; failure delegates zero times; async transform types are rejected; outer reentry re-applies normalization to the latest payload; and synchronous/asynchronous failure identity survives. Selected real-chain tests cover forced-tool reasoning before vendor rewriting and empty-tools normalization before reasoning policy, plus existing hosted tool and image injection tests.

Existing protocol, producer-domain, tool-loop, attempt cleanup and Responses continuation tests remain green, followed by typechecks, purity and full local CI. Preserve the 38 main-checkout and 14 isolated protected files and verify integrated source identity before reporting completion.

Later increments still include call-local translation trips and typed settlement projection contracts. Diagnostic publication admission, exact-artifact workerd CPU/heap comparison, catalog/affinity rollback qualification and final collaboration-overlay disposition remain separate release gates.
