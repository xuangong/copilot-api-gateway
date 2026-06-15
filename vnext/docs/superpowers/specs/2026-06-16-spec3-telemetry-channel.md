# Spec 3 — Telemetry Channel in ExecuteResult

**Status:** Draft (2026-06-16)
**Author:** controller (brainstorming with user)
**Reference impl:** `/Users/zhangxian/projects/copilot-gateway/packages/{provider,gateway}/src/**`
**Target:** `/Users/zhangxian/projects/copilot-api-gateway/vnext/`

---

## 1. Motivation

Spec 2 landed `withUpstreamTelemetry` as a **stream-decorating helper**: a callback-shaped recorder (`recordFirstByteLatency`, `recordSuccess`, `recordFailure`) is injected into the generator that wraps the upstream events. In the production chat-completions path the recorder is wired with no-op stubs (`attempt.ts` lines ~135) — telemetry never actually flows. The legacy `dispatch.ts` + `runConversationAttempt` + `usage-tracker.ts` triple still owns real persistence on the dispatch path.

Three problems with the current shape:

1. **No telemetry on upstream errors** — `withUpstreamTelemetry` only runs after an events stream is produced. An `upstream-error` `ExecuteResult` carries no model identity or performance context, so HTTP failures cannot be billed or attributed.
2. **Interceptors that replace the stream lose telemetry** — `image-generation-shortcut` (chat→image) and `responses/snapshot-sidecar` synthesize fresh streams. The decorator wraps the *original* stream; when an interceptor substitutes a different `AsyncIterable`, telemetry is silently dropped.
3. **Other endpoints can't adopt the chain** — `messages`, `responses`, and `gemini` still go through `dispatch()` precisely because the new chain has no contract for carrying telemetry through `ExecuteResult`. Migrating them requires the channel to exist first.

This spec defines the contract that fixes (1)–(3) and lets us delete the dispatch/conversation-attempt/usage-tracker triple.

---

## 2. Goals

- `ExecuteResult` is the sole carrier of telemetry between `attempt` and `respond` for every endpoint.
- Every `ExecuteResult` — events, upstream-error, internal-error — can carry a `PerformanceTelemetryContext`; event results additionally carry a required `TelemetryModelIdentity`.
- Interceptors that replace the events stream can override the final metadata via an optional `finalMetadata: Promise<EventResultMetadata>` channel.
- Persistence (usage + performance) happens once, in shared `respond-telemetry` helpers invoked by each endpoint's `respond.ts` after the stream settles.
- After migration, `dispatch.ts`, `runConversationAttempt`, and `usage-tracker.ts` are deleted. All four endpoint serve.ts files own their attempt+respond chain end-to-end.

## 3. Non-goals

- New telemetry fields beyond what the reference impl already records (latency, usage, failure flag, pricing snapshot, key id, runtime location).
- Changing the wire format of `repo.usage.record` or `repo.apiKeys.touchLastUsed`.
- Changing `Repo` interface signatures (usage / apiKeys / upstreams) — this spec only relocates *callers*, not the storage contract.
- Touching the `ProviderRequest`/`ProviderResponse` contract from Spec B. `modelKey` is *not* added to `ProviderResponse`.
- Migrating the count-tokens endpoint — it produces `PlainResult`, not `ExecuteResult`, and is out of scope.
- Introducing a new observability backend (OTel, vendor SDK, etc.) — persistence still goes through the existing `Repo`.

---

## 4. Contract

### 4.1 New types (`@vnext/protocols/common`)

```ts
// pricing comes from @vnext/provider's existing ModelPricing
import type { ModelPricing } from '@vnext/provider'

export interface TelemetryModelIdentity {
  model: string         // upstream model id (binding.upstreamModel.id)
  upstream: string      // binding.upstream.name — non-null on this type because
                        // TelemetryModelIdentity is only constructed on the events
                        // path, which always has a resolved binding.
  modelKey: string      // upstream-reported model key (used for pricing lookup)
  cost: ModelPricing | null
}

export interface PerformanceTelemetryContext {
  keyId: string
  model: string
  upstream: string | null   // nullable: upstream-error paths may fire before
                            // binding selection completes (e.g. model-not-found)
  modelKey: string
  stream: boolean
  runtimeLocation: 'bun' | 'cloudflare'
}

export interface EventResultMetadata {
  modelIdentity: TelemetryModelIdentity
  performance?: PerformanceTelemetryContext
}
```

### 4.2 `ExecuteResult` extension

```ts
export interface EventResult<T> {
  type: 'events'
  events: AsyncIterable<T>
  modelIdentity: TelemetryModelIdentity        // REQUIRED
  performance?: PerformanceTelemetryContext
  finalMetadata?: Promise<EventResultMetadata>  // see §4.4
}

export interface UpstreamErrorResult {
  type: 'upstream-error'
  status: number
  headers: Headers
  body: Uint8Array
  performance?: PerformanceTelemetryContext
}

export interface InternalErrorResult {
  type: 'internal-error'
  status: number
  error: Error
  performance?: PerformanceTelemetryContext
}
```

Factory `eventResult` signature: `<T>(events, modelIdentity, performance?, finalMetadata?) => EventResult<T>`. Making `modelIdentity` required at the type level is the enforcement mechanism — code that fails to supply it won't compile.

### 4.3 `finalMetadata` semantics (replacement, not fallback)

`finalMetadata` is **only** filled by interceptors that substitute the events stream (image-generation-shortcut, snapshot-sidecar, and similar). It represents the metadata produced by the *replacement* stream — typically a corrected `modelKey` (which changes pricing) and the synthetic stream's own `failed` flag.

The reader (`eventResultMetadata` helper) picks `finalMetadata` if present, else falls back to `result.modelIdentity` + `result.performance`. Normal pass-through paths must not fill `finalMetadata`.

**Enforcement:** This is a code-review convention, not a type-system constraint (both shapes are structurally valid `EventResult`). If a normal pass-through accidentally sets `finalMetadata`, behavior is well-defined — `eventResultMetadata` simply prefers it — but the redundant promise wastes work and may carry stale identity. `respond-telemetry` emits a `logger.warn` when `finalMetadata` is present without the `__interceptorReplaced` provenance flag (see §4.7) so drift is caught in dev.

### 4.4 `modelKey` correction policy

Because `ProviderResponse` does not carry `modelKey`:

- `attempt` constructs the initial `TelemetryModelIdentity` with `modelKey = sel.bareModel`.
- `respond` observes the first event that carries a `model` field (chat completion chunk, messages `message_start`, responses `response.created`) via `SourceStreamState.rememberModelKey(key)`. The observer accepts only non-empty values that differ from `bareModel`.
- Before persistence, `respond-telemetry` recomputes pricing via `binding.provider.getPricingForModelKey(finalModelKey)` and writes the corrected `TelemetryModelIdentity`.

For interceptor-replaced streams, the interceptor's own `finalMetadata` carries the corrected identity.

### 4.5 `TelemetryRequestContext` (data-plane local)

`@vnext/interceptor`'s `RequestContext` stays minimal (only `requestStartedAt` + `downstreamAbortSignal`). A new `data-plane/chat-flow/shared/telemetry-ctx.ts` exports:

```ts
export interface TelemetryRequestContext {
  apiKeyId: string
  userAgent: string | null      // matches legacy DispatchObsCtx; null when header absent
  requestId: string
  isStreaming: boolean
  runtimeLocation: 'bun' | 'cloudflare'  // sourced from @vnext/platform's
                                          // `getRuntimeLocation()` export
                                          // (verify in Plan Part 1; see §7)
  requestStartedAt: number
}
```

`serve.ts` constructs both `RequestContext` (for interceptors) and `TelemetryRequestContext` (for helpers) from `auth`, `obsCtx`, and the runtime's `executionCtx`. `attempt.generate` accepts both as separate args.

### 4.6 Background persistence

Telemetry persistence calls — both `recordUsage` and `recordPerformance` — wrap their I/O in `@vnext/platform`'s existing `waitUntil(promise)`. No new abstraction; no `scheduleBackground` field on any context type. The two calls are symmetric: both are best-effort writes that must not block the response, and both must survive runtime exit on Cloudflare via `executionCtx.waitUntil`.

### 4.7 New shared modules (`data-plane/chat-flow/shared/`)

- **`attempt-helpers.ts`** — `telemetryModelIdentity(binding, modelKey)`, `upstreamPerformanceContext(telemetryCtx, binding, modelKey)`, `providerResponseToExecuteResult(providerResp, binding, telemetryCtx, modelKey, toEvents)`.
- **`upstream-telemetry.ts`** — pure terminal-frame classifier (full rewrite of the Spec-2 module). Produces `{ events, finalMetadata }` instead of taking a recorder. No callbacks, no side effects. The old `UpstreamTelemetryRecorder` interface and `withUpstreamTelemetry`'s recorder argument are removed.
- **`respond-telemetry.ts`** — `eventResultMetadata(result)`, `recordUsage(telemetryCtx, modelIdentity, usage)`, `recordPerformance(telemetryCtx, performance | undefined, failed)`, `SourceStreamState` class (with `rememberUsage`, `rememberModelKey`, `failedAfter`).
  - **`recordPerformance` undefined-performance handling**: when `performance` is undefined (can happen on `internal-error` results raised before binding selection — e.g. `model-not-found`), the call is a no-op with `logger.debug` trace. No throw, no partial write. Rationale: those failures predate having any keyId/model context to bill, so dropping the perf record is correct.
- **`telemetry-ctx.ts`** — the `TelemetryRequestContext` interface.

### 4.8 Deletions

After all four endpoints migrate:

- `vnext/packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts` (and its colocated `dispatch.test.ts` if any)
- `vnext/packages/gateway/src/observability/attempts/conversation-attempt.ts` (and its tests)
- `vnext/packages/gateway/src/shared/observability/usage-tracker.ts` (and its tests)
- All `dispatchFallback` parameters and cross-protocol bridge branches in serve.ts files

Retained: `usage-extractor.ts` (`applyStreamEvent`, `extractFromJson`) — `SourceStreamState` consumes these. The current WIP diff (cache_creation_input_tokens support) is compatible and lands as a prerequisite commit.

---

## 5. Architecture flow

```
serve.ts
  ├── parse payload + auth
  ├── build RequestContext (interceptor-minimal) + TelemetryRequestContext
  └── attempt.generate({ payload, raw, auth, ctx, telemetryCtx, ... })
        ├── selectBinding
        ├── runInterceptors(chain, terminal)
        │     terminal:
        │       ├── translator.translateRequest(payload)
        │       ├── binding.provider.fetch(providerReq)
        │       ├── non-2xx → upstream-error result with performance context
        │       └── 2xx → providerResponseToExecuteResult(...)
        │             ├── modelIdentity = telemetryModelIdentity(binding, bareModel)
        │             ├── performance   = upstreamPerformanceContext(telemetryCtx, binding, bareModel)
        │             └── events = parseTargetStreamFrames(body)
        └── (interceptors may replace events; if so, they fill finalMetadata)
  └── respond(result, options, telemetryCtx)
        ├── render SSE/JSON via SourceStreamState observer
        │     ├── rememberUsage(extractor.applyStreamEvent(frame))
        │     └── rememberModelKey(frame.model)
        ├── on stream end:
        │     ├── meta = await eventResultMetadata(result)
        │     ├── final modelIdentity = meta + state.modelKey + refreshed pricing
        │     ├── waitUntil(recordUsage(telemetryCtx, finalIdentity, state.usage))
        │     └── waitUntil(recordPerformance(telemetryCtx, meta.performance, state.failed))
        └── upstream-error branch:
              └── waitUntil(recordPerformance(telemetryCtx, result.performance, true))
```

---

## 6. Acceptance criteria

### 6.1 Type-level

- `EventResult<T>.modelIdentity` is required (omission is a compile error).
- `eventResult` factory enforces the same.
- `UpstreamErrorResult.performance` and `InternalErrorResult.performance` are optional but typed.
- `finalMetadata` is `Promise<EventResultMetadata> | undefined`.

### 6.2 Behavioral

- Every successful chat-completions / messages / responses / gemini request results in exactly one `repo.usage.record` row and one `repo.apiKeys.touchLastUsed` call (matching legacy dispatch counts).
- `upstream-error` and `internal-error` paths write **zero** usage rows (no billing for failed upstream calls), matching legacy dispatch behavior.
- Every request — including upstream-error and internal-error paths that have a `performance` context — produces exactly one performance record carrying `keyId`, `model`, `modelKey`, `upstream`, `stream`, `runtimeLocation`, `failed`, `durationMs`. `internal-error` paths raised before binding selection (no `performance` context attached) write zero performance records.
- `modelKey` written to the usage row reflects the upstream-corrected value when the upstream returns a different model than requested (verified with a fake provider that returns a different `model` field). For interceptor-replaced streams, the corrected `modelKey` comes from the replacement's `finalMetadata`, not from `SourceStreamState.rememberModelKey` (which only observes the original stream).
- Interceptor-replaced streams (image-generation-shortcut, snapshot-sidecar) write usage + performance based on the *replacement* stream's `finalMetadata`.
- Pricing snapshot in the usage row uses the corrected `modelKey` (verified by a fake provider with two pricing tiers).

### 6.3 Code-shape

- `bun x tsc --noEmit` clean across `gateway`, `protocols`, `interceptor`, `provider`.
- `bun test` in `gateway` zero new failures relative to the post-Spec-2 baseline. The 6 preexisting failures (dispatch-related streaming/non-streaming/pricing/quota tests) are migrated to the new chain and pass.
- `dispatch.ts`, `conversation-attempt.ts`, `usage-tracker.ts` deleted from disk.
- Four `serve.ts` files contain zero imports from `dispatch.ts`.
- SDK regression: OpenAI suite stays green; Anthropic / Gemini suites do not regress beyond the model-catalog and translator-bug failures already documented in the Spec 2 wrap-up.

### 6.4 Migration order (out of spec scope — see plan)

Plan splits into 4 parts:
1. Protocols types + shared helpers + delete-old-paths scaffold (no endpoint migration yet)
2. chat-completions migration + one-endpoint acceptance battery
3. messages + responses migration
4. gemini migration + 6 preexisting test fixes + SDK regression

---

## 7. Risks & open questions

- **Risk: `runtimeLocation` source.** Bun-side it's `'bun'`; CFW-side `'cloudflare'`. Confirm the platform package already exposes this constant before Plan Part 1 (likely yes — check `@vnext/platform`).
- **Risk: `userAgent` / `requestId` propagation.** Currently in `DispatchObsCtx`; the spec assumes serve.ts can lift these into `TelemetryRequestContext`. Verify each endpoint's `http.ts` already passes `obsCtx` (yes for the four migrated endpoints).
- **Open: `count-tokens` telemetry.** Out of scope here, but legacy dispatch records latency for it. If product wants count-tokens latency tracked post-Spec-3, a follow-up spec wires `recordPerformance` into its `respond.ts` against a synthetic `EventResultMetadata`. Flagged for after Spec 3 ships.
- **Open: `SourceStreamState` reuse boundary.** If a future endpoint needs different terminal semantics (e.g. count-tokens), it should compose `SourceStreamState` rather than subclass. Spec leaves the class final.

---

## 8. References

- `copilot-gateway/packages/provider/src/{model,result}.ts` — type definitions ported
- `copilot-gateway/packages/gateway/src/data-plane/llm/shared/{attempt-helpers,upstream-telemetry,respond}.ts` — implementation pattern
- `copilot-gateway/packages/gateway/src/data-plane/shared/telemetry/{performance,usage}.ts` — persistence helpers
- Spec 2: `vnext/docs/superpowers/specs/2026-06-15-spec2-chat-completions-data-plane-wiring.md`
- Spec 2 plans: `vnext/docs/superpowers/plans/2026-06-15-spec2-part-{1,2,3,4}-*.md`
