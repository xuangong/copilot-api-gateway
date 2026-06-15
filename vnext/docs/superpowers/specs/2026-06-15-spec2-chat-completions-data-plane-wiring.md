# Spec 2 — Chat Completions Data-Plane Migration (Attempt+Respond+Events) + Include-Usage Proof

**Status:** Draft v2 (revised after vnext dispatch.ts deep-dive)
**Date:** 2026-06-15
**Predecessor:** Spec 1 (frame abstraction infrastructure) — landed on `vNext` branch
**Successor specs (decomposition; each migrates one endpoint off `dispatch()`):**
- Spec 3 — Messages endpoint migration + first payload transforms
- Spec 4 — Responses endpoint migration + non-shim transforms
- Spec 5 — Gemini endpoint migration + strip-* family
- Spec 6 — Retry-cyber-policy + server-tool-shim (cross-endpoint)
- Spec 7 — Server-tools orchestrators (image-generation, web-search)
- Spec 8 — Telemetry channel on `ExecuteResult` (lift Spec 1 deferral)
- Spec 9 — Delete `shared/dispatch.ts` once all endpoints migrated

---

## Goal

Migrate **one endpoint** (`chat-completions`) off `shared/dispatch.ts` onto the reference architecture's `attempt → respond → events/{to-sse,to-result} → interceptors/{index,types,*}` sub-tree, and wire **one** interceptor (`include-usage-stream-options`) end-to-end as the wiring proof. This is the first cut of "interceptor chain as the data-plane primary mechanism" in vnext.

After this spec:
- `POST /v1/chat/completions` flows through the new sub-tree; no longer touches `dispatch()`.
- A streaming request without `stream_options` reaches the upstream with `include_usage:true`.
- Observability (latency / token usage / rate-limit) is preserved but **restructured** to decorate `ExecuteResult.events` instead of wrapping the leaf — making it compatible with future response-side transforms (Spec 6+).
- `messages` / `responses` / `gemini` / `count-tokens` keep using `dispatch()` unchanged.

This is **not a "quick proof"** — it is the architecture's first migration cut. Spec 3-5 will replicate this sub-tree per endpoint; total dispatch.ts deletion is Spec 9.

---

## Why Migrate (Not "Embed Interceptor In Dispatch")

vnext `dispatch.ts` (211 LOC) and the reference `attempt+respond+events+interceptors` are two **incompatible abstraction philosophies**:

| Dimension | vnext `dispatch()` | Reference attempt+respond |
|---|---|---|
| Currency | `Response` | `ExecuteResult<ProtocolFrame<T>>` |
| Transform extension point | None — only via translator | Interceptor chain wrapping `ExecuteResult` |
| Cross-protocol translation | translator-registry handles ALL routes (same-protocol uses identity translator) | `attempt.ts` branches on `targetApi`: same-protocol → leaf+chain; cross-protocol → `translate-traverse` |
| Observability | Wraps the leaf (`runConversationAttempt`) | Decorates `ExecuteResult.events` (`withUpstreamTelemetry`) — chain-friendly |
| Error model | `repackage` central, strongly coupled to `sourceApi` | `ExecuteResult` 3-state union; `respond.ts` renders |

Embedding interceptors into `dispatch()`'s `Response` currency would mean Spec 1's frame layer is permanently dead code on the dispatch path. The whole point of Spec 1 was to make `ExecuteResult<ProtocolFrame<T>>` the chain's currency. Migration is the only way to honor Spec 1's investment.

**Amortization:** Spec 3 (messages), Spec 4 (responses), Spec 5 (gemini) each clone this sub-tree structure. The migration cost is paid 1.x times for the cluster, not 4x.

---

## Architecture Overview (Post-Spec 2)

```
HTTP request → chat-flow/routes.ts → chat-completions/serve.ts
                                          │
                                          ▼
                                     parse payload
                                     capture wantsStream + includeUsageChunk
                                          │
                                          ▼
                                chatCompletionsAttempt.generate({...})
                                          │
                                          ▼
                            runInterceptors(invocation, ctx, chain, leaf)
                            chain = [withUsageStreamOptionsIncluded]
                                          │
                                          ▼  leaf:
                                     enumerateBindingCandidates(payload.model, ...)
                                     pick first candidate
                                     getTranslator(sourceApi, targetEndpoint)
                                     translator.translateRequest(payload)
                                          │
                                          ▼
                                     provider.fetch(req, {signal}) → Response
                                          │
                                          ▼
                                     if (!resp.ok) → readUpstreamError(resp)
                                     if (ok)       → eventResult(
                                                       withUpstreamTelemetry(
                                                         parseChatCompletionsStream(body),
                                                         ctx, telemetryCtx
                                                       ))
                                          │
                                          ▼
                            respondChatCompletions(c, result, wantsStream, includeUsageChunk)
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
      upstream-error                 events                    internal-error
      (use repackage)            (to-sse OR to-result)         Response.json
              │                           │                           │
              └───────────────────────────┴───────────────────────────┘
                                          ▼
                                    HTTP response
```

**Key shift from dispatch.ts:** Observability moves from wrapping `provider.fetch` (the leaf) to wrapping `ExecuteResult.events` (a stream decorator). This decouples observability from the leaf so future interceptors that wrap/replace the result (retry, server-tool-shim) work correctly.

---

## Components Reused vs Reimplemented

### Reused as-is (no migration cost in this spec)

| Component | Path |
|---|---|
| `parseModelRouting` | `routing/binding-resolver.ts` |
| `enumerateBindingCandidates` | `routing/candidates.ts` |
| `selectPair` | `dispatch/pair-selector.ts` |
| `getTranslator` / translator-registry | `dispatch/translator-registry.ts` |
| `repackageUpstreamError` | `errors/repackage.ts` |
| `parseTargetSSE` | `chat-flow/shared/sse-readers.ts` (used for hub frame parsing — but for chat-completions we now go straight through `parseChatCompletionsStream`) |
| `encodeClientSSE` | `dispatch/sse-writers.ts` (legacy path; chat-completions no longer uses) |
| `runConversationAttempt`'s underlying telemetry recorders | `observability/attempts/conversation-attempt.ts` — we **decompose** this: the latency/usage primitives stay; the "wrap a leaf" orchestration is replaced by stream decorators |
| `provider.fetch` contract (Plan B) | `@vnext/provider` |
| `Spec 1` exports | `@vnext/protocols/{chat,common}`, `@vnext/interceptor` |

### Newly built in this spec

- `attempt.ts` — chain runner + leaf (with translator + provider.fetch + parser)
- `respond.ts` — 3-state ExecuteResult renderer
- `events/to-sse.ts`, `events/to-result.ts` — re-serialization
- `interceptors/{types,index,include-usage-stream-options}.ts`
- `shared/upstream-telemetry.ts` — `withUpstreamTelemetry(stream, ctx, telemetryCtx)` decorator that records latency at first byte, accumulates usage from frames, records performance on completion. Extracted from `runConversationAttempt` body.
- (optional small) `shared/select-binding.ts` — extracts the candidate-enumeration prelude from `dispatch.ts` so attempt's leaf can call it. Pure refactor, no behavior change.

### Untouched (preserves vnext capability)

- `shared/dispatch.ts` — still services messages/responses/gemini/count-tokens
- Other endpoint serves (`messages/serve.ts`, etc.)
- Routing / pair-selection / translator infra
- All upstream rate-limit + 429 handling logic (reused from `repackage`)

---

## File Structure

### New files in `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/`

| Path | Responsibility | LOC est. |
|---|---|---|
| `attempt.ts` | Build `ChatCompletionsInvocation`; `runInterceptors` over chain; leaf does candidate enumeration + translator + `provider.fetch` + decode to `ExecuteResult`. Same-protocol only on the new path — when `targetEndpoint !== 'chat_completions'` leaf bridges to `dispatch(raw, {...})` (temporary, deleted in Spec 6). | ~80 |
| `respond.ts` | 3-state ExecuteResult dispatch. `upstream-error` → repackage. `events + stream` → SSE via to-sse. `events + !stream` → JSON via to-result. `internal-error` → JSON error. | ~70 |
| `events/to-sse.ts` | `chatCompletionsProtocolFrameToSSEFrame` — verbatim from reference | ~12 |
| `events/to-result.ts` | `collectChatCompletionsProtocolEventsToResult` — reassemble + usage lift | ~80 |
| `interceptors/types.ts` | `ChatCompletionsInvocation`, `ChatCompletionsInterceptor` re-export | ~10 |
| `interceptors/index.ts` | `[withUsageStreamOptionsIncluded]` registry | ~8 |
| `interceptors/include-usage-stream-options.ts` | The proof interceptor | ~10 |

### New files in `vnext/packages/gateway/src/data-plane/chat-flow/shared/`

| Path | Responsibility | LOC est. |
|---|---|---|
| `upstream-telemetry.ts` | `withUpstreamTelemetry(stream, ctx, telemetryCtx)` — stream decorator that records first-byte latency, accumulates usage, records perf on stream completion/error. Replaces `runConversationAttempt`'s wrapping role for chat-completions. | ~80 |
| `select-binding.ts` | `selectBinding(payload.model, sourceApi, auth) → {binding, targetEndpoint, translator} \| ErrorResponse` — extracts the candidate+pair+translator prelude from `dispatch.ts`. | ~50 |

### Modified files

| Path | Change |
|---|---|
| `chat-completions/serve.ts` | Drop `dispatch()`. New body: parse → capture intent → `chatCompletionsAttempt.generate` → `respondChatCompletions`. | rewrite, ~40 |
| `observability/attempts/conversation-attempt.ts` | Extract telemetry primitives (latency timer, usage recorder, perf recorder) into reusable helpers. `runConversationAttempt` itself stays — it still serves dispatch() for other endpoints. | ~30 changed |

### Test files

| Path | Coverage |
|---|---|
| `chat-flow/chat-completions/__tests__/attempt.test.ts` | (a) stub interceptor mutates payload; (b) provider 200 → `EventResult`; (c) provider 401 → `UpstreamErrorResult`; (d) interceptor throw → `InternalErrorResult`; (e) same-protocol leaf path |
| `chat-flow/chat-completions/__tests__/respond.test.ts` | 3-state x stream/non-stream matrix, mid-stream error event-frame |
| `chat-flow/chat-completions/events/__tests__/to-sse.test.ts` | done / usage filter / passthrough |
| `chat-flow/chat-completions/events/__tests__/to-result.test.ts` | reassemble + usage lift |
| `chat-flow/chat-completions/interceptors/__tests__/include-usage-stream-options.test.ts` | 3 input cases |
| `chat-flow/shared/__tests__/upstream-telemetry.test.ts` | first-byte latency recorded once; usage accumulated; perf recorded on close + on error |
| `chat-flow/shared/__tests__/select-binding.test.ts` | model found / not found / unsupported source-api / no translator |
| `tests/integration/include-usage-wiring.test.ts` | E2E via FakeProvider: stream=true + no stream_options → upstream sees include_usage:true |

---

## Data Flow Examples (revised)

### Same-protocol, streaming, no stream_options

```
1. POST /v1/chat/completions  {model, messages, stream:true}
2. serve.ts: payload = parseChatPayload(raw); wantsStream=true; includeUsageChunk=false
3. attempt.generate:
     invocation = {payload, headers:{}}
     runInterceptors(invocation, ctx, [withUsageStreamOptionsIncluded], leaf)
       └─ withUsageStreamOptionsIncluded: payload.stream_options.include_usage = true
           └─ leaf:
                {binding, targetEndpoint, translator} = selectBinding(payload.model, 'chat_completions', auth)
                upstreamPayload = await translator.translateRequest(payload, ctx)
                                  // same-protocol = identity translator, no-op
                req = buildProviderRequest(upstreamPayload, invocation.headers)
                resp = await binding.provider.fetch(req, {signal})
                if (!resp.ok) return readUpstreamError(resp)
                stream = parseChatCompletionsStream(resp.body)
                telemetryStream = withUpstreamTelemetry(stream, ctx, telemetryCtx)
                return eventResult(telemetryStream)
4. respond:
     events + stream=true:
       streamSSE: for await (frame of result.events) {
         sse = chatCompletionsProtocolFrameToSSEFrame(frame, {includeUsageChunk:false})
         if (sse) write(sse)
       }
     telemetryStream observes each frame, accumulates usage, records on close
```

### Cross-protocol (e.g. chat-completions over a messages-only model)

Spec 2 **simplification**: the new attempt/respond path only handles same-protocol routing (`targetEndpoint === 'chat_completions'`). When `selectBinding` returns a different `targetEndpoint` (e.g. chat-completions request hitting a messages-only model), the leaf bridges to the **old dispatch() path** by calling `dispatch(raw, {...})` directly and wrapping the returned `Response` into a synthetic `EventResult` for `respond.ts` (or short-circuits: leaf can return the `Response` via a sidecar return type that `respond.ts` passes through). Implementation detail: easiest is to have `attempt.generate` itself short-circuit before invoking the chain — if `targetEndpoint !== 'chat_completions'`, return `await dispatch(raw, {...})` directly to serve.ts, skipping interceptors. Acceptable because the cross-protocol path doesn't benefit from chat-completions-specific interceptors anyway.

This is a temporary bridge; Spec 6 ships native cross-protocol attempts and the bridge is deleted. The bridge means Spec 2 has zero functional regression.

### Error path

| Trigger | Branch | Render |
|---|---|---|
| Malformed JSON body | serve catches → `internalErrorResult(400)` | `Response.json({error}, 400)` |
| Model not found | leaf returns `internalErrorResult(404)` carrying `selectBinding` failure | repackage as 404 OpenAI envelope |
| `provider.fetch` 4xx/5xx | leaf returns `readUpstreamError(resp)` | `repackageUpstreamError(resp, 'chat_completions')` |
| Interceptor throws | runInterceptors rethrows → attempt catches → `internalErrorResult(502)` | `Response.json({error}, 502)` |
| Mid-stream `{error}` payload | `parseChatCompletionsStream` throws inside `for await` | streamSSE catches → write `sseFrame(JSON, 'error')` |
| 429 rate-limit | `withUpstreamTelemetry` propagates via `readUpstreamError`; respond.ts repackage layer handles 429 specifically | `repackageRateLimit` (lift from dispatch.ts logic) |

---

## Observability Restructuring

**Current (dispatch.ts):**
```
runConversationAttempt({
  apiKeyId, model, modelKey, pricing, sourceApi, targetApi, upstream, ...,
  call: async () => { return await provider.fetch(...) }
})
```
The "attempt" wraps the leaf call. All latency/usage/perf measurement happens around the function call.

**Spec 2 (attempt.ts):**
```
const telemetryCtx = { apiKeyId, model, modelKey, pricing, sourceApi:'chat_completions',
                       targetApi:'chat_completions', upstream, ... }
const stream = parseChatCompletionsStream(resp.body)
const telemetryStream = withUpstreamTelemetry(stream, ctx, telemetryCtx)
return eventResult(telemetryStream)
```
The decorator measures **first frame** latency (when `for await` first yields), **accumulates usage** from frames (chat-completions emits usage in trailing chunks), and **records perf** when the stream completes or errors. This matches the reference's `withUpstreamTelemetry`.

**Why this is better long-term:**
- Interceptors that wrap `ExecuteResult` (retry, server-tool-shim) can replace the events stream — telemetry still attaches to whatever stream actually drains to the client.
- For non-stream requests, the same stream is drained by `collectChatCompletionsProtocolEventsToResult` — telemetry still fires on completion.
- For upstream errors (no stream), `readUpstreamError` carries no telemetry stream → record perf at the upstream-error renderer in respond.ts.

**`runConversationAttempt` stays alive** for `dispatch()` users (other endpoints). Spec 3-5 each migrate one endpoint onto `withUpstreamTelemetry`. Spec 9 deletes both.

---

## Non-Goals

- **Other endpoints unchanged.** `messages/*`, `responses/*`, `gemini/*`, `count-tokens/*` all still call `dispatch()`.
- **Cross-protocol translation on the new path.** Falls back to dispatch() for chat-completions calls hitting non-chat_completions targets. Spec 6+ adds native cross-protocol attempts.
- **Additional interceptors.** Only `include-usage-stream-options`. `normalize-usage`, `vendor-*`, `disable-reasoning-on-forced-tool-choice` are Spec 3-5+ depending on endpoint priority.
- **Telemetry fields on `ExecuteResult`.** Stays 裁剪式. Spec 8 lifts.
- **Delete `runConversationAttempt`.** It still serves dispatch(); deletion is Spec 9.
- **Spec 1 type/runtime changes.** Frozen.

---

## Acceptance Checklist

- [ ] `bun x tsc --noEmit` in `gateway` / `protocols` / `interceptor` packages — zero new errors (pre-existing tolerated)
- [ ] `bun test` in `gateway` package — zero new failures (pre-existing tolerated)
- [ ] `bun test` in `protocols` package — all green
- [ ] 8 new unit test files green
- [ ] 1 new integration test green (requires `bun run local`)
- [ ] `tests/sdk-openai.test.ts` green — chat-completions streaming + non-streaming both pass; no regression vs pre-Spec-2 baseline
- [ ] `tests/sdk-anthropic.test.ts` / `tests/sdk-gemini.test.ts` green — proof other endpoints unaffected
- [ ] `routes.ts` ≤40 lines
- [ ] Zero modifications under `chat-flow/messages/`, `chat-flow/responses/`, `chat-flow/gemini/`, `chat-flow/count-tokens/`
- [ ] Zero modifications to `provider.fetch` signature, `runInterceptors` implementation, `ExecuteResult` type shape
- [ ] `runConversationAttempt` still exists and is still called by `dispatch.ts`
- [ ] Cross-protocol bridge: chat-completions request to messages-only model still works (via dispatch() fallback)

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Telemetry restructuring breaks per-key usage tracking | `withUpstreamTelemetry` unit tests cover frame accumulation + record-on-close. Integration test asserts usage row appears in D1 after streaming completion. |
| Cross-protocol bridge ugly | Documented as temporary; Spec 6 deletes it. Add `// FIXME(spec-6): native cross-protocol attempts` comment. |
| FakeProvider can't record requests | Add 5-line `lastRequest` getter if absent. |
| 429 rate-limit handling needs lifting from dispatch.ts | Extract `repackageRateLimit(response) → Response` helper; both paths use it. |
| Same-protocol-only leaf misclassifies a candidate's pair | `selectPair('chat_completions', endpoints)` already returns `'chat_completions'` if available, else other targets — leaf checks the returned `targetEndpoint`, bridges otherwise. |
| Estimated 500-600 LOC under-counts | Time-box: if implementation exceeds 800 LOC, halt and re-evaluate scope (likely need to defer something to Spec 3). |

---

## Migration Impact

- **Spec 1 compatibility:** zero — only consumes Spec 1 exports.
- **Other endpoints:** zero impact — dispatch() unchanged.
- **SDK integration tests:** zero regression expected.
- **Surface that future specs replicate:** the new chat-completions sub-tree IS the template for messages/responses/gemini specs.
- **`dispatch.ts` lifecycle:** starts shrinking. After Spec 5 ships, dispatch.ts only serves count-tokens (if at all). Spec 9 final deletion.

---

## Open Questions

None — design locked. Architecture: migrate one endpoint fully; bridge cross-protocol to dispatch() temporarily; restructure observability to stream-decorator pattern; defer telemetry-on-ExecuteResult to Spec 8.
