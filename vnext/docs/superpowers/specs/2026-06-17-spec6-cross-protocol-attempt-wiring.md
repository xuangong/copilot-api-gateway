# Spec 6: Cross-Protocol Attempt Wiring

**Status:** Draft (2026-06-17)
**Predecessor:** Spec 3 (telemetry channel) — landed 2026-06-16
**Reference:** `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/`

## 1. Goal

Enable the four data-plane attempt modules (`chat-completions`, `messages`, `responses`, `gemini`) to handle requests where the client's source protocol differs from the upstream model's hub protocol, by routing through the existing `@floway-dev/translate` translator pairs. Remove the three 501 "cross-protocol attempts not yet supported" short-circuits introduced as placeholders during Spec 3 Part 4.

After Spec 6 lands:
- `gpt-5.4-mini` (responses-only upstream) served via `/v1/chat/completions` returns 200, not 400
- `gpt-4.1` (chat_completions-only upstream) served via `/v1/responses` returns 200, not 501
- `claude-3-7` served via `/v1/chat/completions` (messages upstream) keeps working
- All Gemini native requests (no Gemini upstream exists) keep working through translation

## 2. Background

### 2.1 Current state (post Spec 3 Part 4)

Each of the four attempts performs `selectBinding`, gets back `{ targetEndpoint, translator }`. When `targetEndpoint` matches the attempt's own protocol, it executes the native chain (interceptors → terminal → `withUpstreamTelemetry`). When it doesn't, it returns a 501:

| Attempt | 501 site | Branch condition |
|---|---|---|
| `chat-completions/attempt.ts` | line 86 | `sel.targetEndpoint !== 'chat_completions'` |
| `messages/attempt.ts` | line 261 | `sel.targetEndpoint !== 'messages'` |
| `responses/attempt.ts` | line 223 | `sel.targetEndpoint !== 'responses'` |
| `gemini/attempt.ts` | (no 501; gemini has no identity target — every successful selection already drives `parseHubStream → unwrapHubFrames → translator.translateEvents`. Spec 6 unifies this through the shared helper but the runtime behavior is unchanged.) | always cross-protocol |

The translator package (`vnext/packages/translate/src/`) is fully built: 10 pairs, all registered in `translator-registry.ts`. `sel.translator` is exposed by `selectBinding` for all four protocols. Nothing in the chain consumes it.

### 2.2 Reference design (copilot-gateway)

Reference uses a `traverseTranslation` helper (`packages/gateway/src/data-plane/llm/shared/translate-traverse.ts`) that:
1. Calls `translator.translateRequest(sourcePayload)` → hub payload
2. Invokes the **hub protocol's** `attempt.generate(hubPayload)` (recursive into another attempt)
3. Wraps the returned event stream via `translator.events(...)` to translate hub events back to source events
4. Returns a fully-formed source-protocol `ExecuteResult`

Hub interceptors run on hub payload/events (not source); source interceptors run **before** translation only if the source attempt invokes them prior to entering `traverseTranslation` (in practice, source attempts in the reference defer all dispatch logic to translation when cross-protocol, so source interceptors don't run on cross-protocol requests).

## 3. Design

### 3.1 Architecture

```
client (source protocol)
  → sourceAttempt.generate(payload)
    → selectBinding → { targetEndpoint, translator }
    → if (targetEndpoint === source) { native chain }
    → else { traverseTranslation(payload, translator, hubAttempt.generate, ctx) }
      ├─ translator.translateRequest(sourcePayload) → hubPayload
      ├─ hubAttempt.generate(hubPayload, { inheritedHeaders, inheritedTelemetryCtx, snapshotMode: 'none' })
      │     → hub-native chain (selectBinding revalidates, hub interceptors, hub terminal, hub telemetry)
      │     → returns ExecuteResult<ProtocolFrame<HubFrame>>
      ├─ translator.translateEvents(events) → AsyncIterable<ProtocolFrame<SourceFrame>>
      ├─ tag telemetry: modelIdentity.translatorPair = { source, hub }
      ├─ attach result.translateBody = translator.translateBody (for non-streaming)
      └─ return ExecuteResult<ProtocolFrame<SourceFrame>>
  → sourceRespond(result, ctx)
      ├─ if (stream) → SSE/streaming path on source events
      └─ if (!stream)
          ├─ if (result.translateBody) → reassemble hub events → JSON → translateBody → source JSON
          └─ else → reassemble source events → source JSON  (native path)
```

### 3.2 Decisions (locked during brainstorming)

| # | Decision | Rationale |
|---|---|---|
| Q1 | Only **inner (hub)** interceptors run on cross-protocol requests | Matches reference; avoids dual-shape interceptor contract; vNext's interceptor registries are already keyed by protocol |
| Q2 | Attempts call each other via a shared `traverseTranslation` helper; helper takes inner attempt as a function reference (no top-level imports between attempts inside helper) | Maximum reuse of hub attempt's full chain (selectBinding, interceptors, telemetry, terminal); cleanest re-entry surface |
| Q3 | Add optional `translatorPair: { source, hub }` field to `TelemetryModelIdentity` | Structured field aligns with Spec 3's telemetry-channel philosophy; downstream metrics can group by pair |
| Q4 | Translator validation errors → 400; other translator throws → 500 | `TranslatorValidationError` distinguishes client-side payload-shape issues from gateway-side translation bugs |
| Q5 | Non-streaming cross-protocol uses `translator.translateBody(hubJson)` (existing in all 10 pairs) | Direct field-mapping is more accurate than reassembling events from translated stream |
| Q6 | `inheritedInvocationHeaders` flow from outer (source) attempt to inner (hub) attempt unchanged | One client request = one trace context; hub attempt overrides only its own auth/upstream-specific headers |

### 3.3 New module: `traverseTranslation`

**Path:** `vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts`

**Signature:**

```ts
import type { Protocol } from '@vnext/protocols/common'
import type { PairTranslator } from '../../dispatch/translator-registry.ts'
import type { ExecuteResult, ProtocolFrame } from '@vnext/protocols/common'

export interface InnerAttemptArgs {
  payload: Record<string, unknown>
  auth: AuthContext
  inheritedHeaders: Record<string, string>
  inheritedTelemetryCtx: TelemetryRequestContext
  snapshotMode: 'none'
  requestId?: string
  userAgent?: string
  signal?: AbortSignal
}

export interface TraverseTranslationArgs<HubFrame, SourceFrame> {
  sourcePayload: Record<string, unknown>
  sourceProtocol: Protocol
  hubProtocol: Protocol
  translator: PairTranslator
  innerAttempt: (args: InnerAttemptArgs) => Promise<ExecuteResult<ProtocolFrame<HubFrame>>>
  inheritedHeaders: Record<string, string>
  inheritedTelemetryCtx: TelemetryRequestContext
  auth: AuthContext
  requestId?: string
  userAgent?: string
  signal?: AbortSignal
  fallbackMaxOutputTokens?: number
  /** Used by Gemini-via translators which need the bare model in their ctx. */
  model?: string
}

export async function traverseTranslation<HubFrame, SourceFrame>(
  args: TraverseTranslationArgs<HubFrame, SourceFrame>,
): Promise<ExecuteResult<ProtocolFrame<SourceFrame>>>
```

**Implementation steps:**

1. Try `translator.translateRequest(sourcePayload, { signal, fallbackMaxOutputTokens, model })`.
   - `TranslatorValidationError` → `internalErrorResult(400, err)` with `reason: 'translator-validation'` carried via the new `InternalErrorResult.reason?` field (§3.6).
   - other throw → `internalErrorResult(500, err)` with `reason: 'translator-internal'`.
2. Call `innerAttempt({ payload: hubPayload, ...args, snapshotMode: 'none' })`.
3. Branch on `inner.type`:
   - `upstream-error` → return inner unchanged.
   - `internal-error` → return inner with `reason` prefixed by `via-translator:${source}→${hub}`.
   - `events` → continue to step 4.
4. Wrap `inner.events` via `translator.translateEvents(...)`. Catch translator iterator errors and emit a final source-protocol error frame instead of throwing.
5. Construct return value:
   ```ts
   return {
     type: 'events',
     events: translatedEvents,
     modelIdentity: {
       ...inner.modelIdentity,
       translatorPair: { source: args.sourceProtocol, hub: args.hubProtocol },
     },
     performance: inner.performance,
     translateBody: translator.translateBody,
   }
   ```

**Helper does NOT import attempt modules.** Each `attempt.ts` imports the others' `attempt` exports at module top level (ESM cyclic imports are already used today by `gemini/attempt.ts` importing helpers from `messages/attempt.ts` + `responses/attempt.ts`; calls live inside functions). Helper accepts `innerAttempt` as a function ref.

### 3.4 Attempt module changes

For each of `chat-completions/attempt.ts`, `messages/attempt.ts`, `responses/attempt.ts`:

```ts
if (sel.targetEndpoint !== <ownProtocol>) {
  const hubAttempt = pickHubAttempt(sel.targetEndpoint)  // simple switch
  return await traverseTranslation({
    sourcePayload: args.payload,
    sourceProtocol: <ownProtocol>,
    hubProtocol: sel.targetEndpoint,
    translator: sel.translator,
    innerAttempt: (innerArgs) => hubAttempt.generate(adaptInnerArgs(innerArgs)),
    inheritedHeaders: <constructed-from-source-args>,
    inheritedTelemetryCtx: args.telemetryCtx,
    auth: args.auth,
    requestId: args.requestId,
    userAgent: args.userAgent,
    signal: args.ctx.downstreamAbortSignal,
    fallbackMaxOutputTokens: sel.binding.upstreamMaxOutputTokens,
    model: sel.bareModel,
  })
}
// native path unchanged below
```

For `gemini/attempt.ts`: there's no native gemini hub. The `selectBinding`-returned `targetEndpoint` is always one of `chat_completions | messages | responses`, never `gemini`. The current implementation already runs cross-protocol via `parseHubStream → unwrapHubFrames → translator.translateEvents`; Spec 6 replaces that bespoke path with the same `traverseTranslation` call so telemetry stamping and `translateBody` propagation match the other three attempts.

`pickHubAttempt(p)` is a small dispatch in `chat-flow/shared/hub-attempt-dispatch.ts`:

```ts
export function pickHubAttempt(p: Protocol) {
  switch (p) {
    case 'chat_completions': return chatCompletionsAttempt
    case 'messages': return messagesAttempt
    case 'responses': return responsesAttempt
    default: throw new Error(`no hub attempt for protocol: ${p}`)
  }
}
```

`adaptInnerArgs` per source attempt is responsible for shaping `InnerAttemptArgs` into each hub attempt's existing args type (e.g., `ChatCompletionsAttemptArgs`, `MessagesAttemptArgs`, `ResponsesAttemptArgs`). The three `*AttemptArgs` types differ in optional fields (`userAgent`/`requestId` on responses, `selectBinding` on all three for testability) but share the load-bearing fields: `payload`, `auth`, `ctx`, `telemetryCtx`. The adapter constructs a synthetic `RequestContext` whose `downstreamAbortSignal` comes from `InnerAttemptArgs.signal`.

### 3.5 Inner attempt input extension

Each of the four `*AttemptArgs` types gains optional fields:
```ts
inheritedHeaders?: Record<string, string>
snapshotMode?: 'none'
```

`telemetryCtx` is already required on all four attempts — when invoked as inner, the source-side `telemetryCtx` is passed through unchanged (one client request = one telemetry context). No new field needed.

When `inheritedHeaders` is present, the attempt merges it into its `Invocation.headers` BEFORE the terminal runs, so any auth/upstream-specific headers the inner attempt adds take precedence over inherited values.

When `snapshotMode === 'none'`:
- `responses` attempt skips its snapshot-sidecar write
- other protocols ignore the hint (no-op)

External entrypoints (`serve.ts`) never pass these fields.

### 3.6 ExecuteResult extension

`vnext/packages/protocols/src/common/result.ts`:

`EventResult<T>` adds:
```ts
translateBody?: (hubJson: unknown, ctx: TranslateContext) => unknown | Promise<unknown>
```

`InternalErrorResult` adds:
```ts
reason?: string
```

`internalErrorResult(...)` factory and `eventResult(...)` factory both take an optional final argument to set the new fields. `translateBody` is set only by `traverseTranslation` (native path leaves it undefined). `reason` is set by `traverseTranslation` for translator failures and by future call sites that want to tag internal-error provenance. Consumed by `respond.ts` non-streaming path (translateBody) and by error-logging tap (reason).

### 3.7 respond.ts non-streaming changes

Each `respond.ts` non-streaming branch:

```ts
if (!ctx.stream) {
  const hubProtocol = result.modelIdentity.translatorPair?.hub ?? <ownProtocol>
  const reassembled = await reassembleEventsToJson(result.events, hubProtocol)
  const finalJson = result.translateBody
    ? await result.translateBody(reassembled, { signal, fallbackMaxOutputTokens, model: result.modelIdentity.model })
    : reassembled
  return jsonResponse(finalJson, finalizeTelemetry(result))
}
```

Each protocol's `events/reassemble.ts` (already exists per `gemini`, `messages`, `responses`, `chat-completions`) gains an optional `hubProtocol` argument; when provided, the reassembler decodes events under the hub's frame taxonomy. For `chat_completions` and `responses` the reassembler is unchanged (events flow as their own frame shape natively); for `messages` source served via a hub, the existing `reassembleEventsToJson` already operates on bare hub events when fed through the unwrapped stream.

### 3.8 Telemetry types

`vnext/packages/protocols/src/common/result.ts` `TelemetryModelIdentity` (current shape: `model / upstream / modelKey / cost`) gains:

```ts
export interface TelemetryModelIdentity {
  readonly model: string
  readonly upstream: string
  readonly modelKey: string
  readonly cost: ModelPricing | null
  readonly translatorPair?: {
    readonly source: Protocol
    readonly hub: Protocol
  }
}
```

Logging point (dispatch finalize) emits `translatorPair` as a structured field when present.

### 3.9 TranslatorValidationError

**New file:** `vnext/packages/translate/src/errors.ts`

```ts
export class TranslatorValidationError extends Error {
  readonly kind = 'translator-validation'
  constructor(message: string, public readonly field?: string) {
    super(message)
    this.name = 'TranslatorValidationError'
  }
}
```

Audit pass over 10 pairs (`request.ts`, `events.ts`, `body.ts`): convert client-payload-shape throws to `TranslatorValidationError`; leave gateway-internal throws (e.g., "unexpected upstream frame") as plain `Error`.

## 4. Coverage matrix

| source ↓ \ hub → | chat_completions | messages | responses | gemini |
|---|---|---|---|---|
| chat_completions | native | ✓ | ✓ | (✓ — registered) |
| messages | ✓ | native | ✓ | (deliberately not in dispatch table per registry comment) |
| responses | ✓ | ✓ | native | ✓ |
| gemini | ✓ | ✓ | ✓ | (no native; always translates) |

All ✓ rows must pass acceptance tests in §6.

## 5. File changes summary

**New files:**
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/hub-attempt-dispatch.ts`
- `vnext/packages/translate/src/errors.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.test.ts`
- `vnext/packages/translate/src/errors.test.ts`
- `vnext/tests/integration/cross-protocol/*.test.ts` (4 endpoint × 2 stream modes = 8 cases)

**Modified:**
- `vnext/packages/protocols/src/common/result.ts` — `translateBody?` on `EventResult`, `reason?` on `InternalErrorResult`, `translatorPair?` on `TelemetryModelIdentity`, factory signatures updated
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts` — replace 501 with traverseTranslation
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts` — same
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts` — same
- `vnext/packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts` — replace bespoke `parseHubStream → unwrapHubFrames → translator.translateEvents` path with `traverseTranslation`; delete now-redundant helpers (`parseHubStream`, `synthesizeHubFramesFromJson`, `targetToHubProtocol`, `unwrapHubFrames`) since hub attempts own those steps
- `vnext/packages/gateway/src/data-plane/chat-flow/{chat-completions,messages,responses,gemini}/respond.ts` — non-streaming translateBody hook
- `vnext/packages/gateway/src/data-plane/chat-flow/{chat-completions,messages,responses,gemini}/events/reassemble.ts` — accept optional `hubProtocol` arg where needed
- `vnext/packages/translate/src/<10 pairs>/{request,events,body}.ts` — switch eligible throws to `TranslatorValidationError`

## 6. Acceptance

### 6.1 Unit tests

- `traverse-translation.test.ts`: 7 cases (happy path, ValidationError → 400, generic error → 500, upstream-error pass-through, internal-error reason prefix, translateEvents mid-stream error, header inheritance)
- Per-attempt cross-protocol unit tests (4 files × N hub targets each): assert correct hub attempt invoked, snapshotMode='none' passed, telemetry.translatorPair populated
- `errors.test.ts`: TranslatorValidationError type identification
- 10 pair `request.test.ts` updates: malformed source payload → `TranslatorValidationError`
- 4 `respond.test.ts` updates: non-streaming + translateBody path

### 6.2 Integration tests

`vnext/tests/integration/cross-protocol/`:

| Case | Source | Upstream protocol | Stream | Expected |
|---|---|---|---|---|
| 1 | `/v1/chat/completions` | responses (gpt-5.4-mini) | both | 200 |
| 2 | `/v1/responses` | chat_completions (gpt-4.1) | both | 200 |
| 3 | `/v1/chat/completions` | messages (claude-3-7) | both | 200 |
| 4 | `/v1beta/.../generateContent` | any non-gemini upstream | both | 200 |

= 8 test cases. All must pass against `bun run local`.

### 6.3 SDK regression

`bun run test:integration:{anthropic,openai,gemini}` parity with the Spec 3 closing baseline. No new failures.

### 6.4 Static gates

- `bun typecheck` clean
- `grep -r 'cross-protocol attempts not yet supported' vnext/packages/` returns 0 lines

### 6.5 Production validation

After Docker rebuild and deploy to `gateway.xianliao.de5.net`:
- `gpt-5.4-mini` via `/v1/chat/completions` → 200 (was 400)
- `gpt-4.1` via `/v1/responses` → 200 (was 501)
- All four §6.2 cases reproduce on prod.

## 7. Out of scope

- Body-translator improvements beyond what's already in `packages/translate/src/<pair>/body.ts`
- Reordering/restructuring `selectBinding` (still returns `{ targetEndpoint, translator }` as today)
- Changes to translator registry — all 10 pairs already wired
- Cross-protocol cancellation semantics beyond `signal` propagation

## 8. Open risks

| Risk | Mitigation |
|---|---|
| ESM cyclic imports between attempts cause runtime errors | Verify with `bun run` boot-up smoke; calls happen inside functions, not module top-level |
| `translateBody` correctness gaps for non-streaming (some pairs may have stub implementations) | Audit body.ts in 10 pairs as part of Phase 1; flag any not production-ready |
| Telemetry consumers (dashboard) don't yet read `translatorPair` | Additive field; existing consumers ignore unknown keys |
| Some pairs' `events.ts` may not yet implement `translateEvents` for all event types post Spec 3 frame format | Audit during Phase 1; fix gaps per pair |
