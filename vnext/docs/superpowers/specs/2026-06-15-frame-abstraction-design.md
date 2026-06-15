# Frame Abstraction Infrastructure (Spec 1 / D-full Stage 1)

**Status:** Draft v2
**Date:** 2026-06-15
**Predecessor:** Plan B (`provider.fetch(req, opts) → Response`)
**Successor specs:**
- Spec 2 — Port 10 missing transforms + wire response-side chain into data-plane
- Spec 3 — Telemetry channel in `ExecuteResult` (deferred until trigger)

---

## Goal

Land the typed protocol-frame layer inside `@vnext/protocols` plus the per-endpoint stream-interceptor type aliases inside `@vnext/interceptor`. After this spec, downstream code can `parseChatCompletionsStream(body) → AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>>` and the `ExecuteResult<T>` carrier type exists, but **nothing in the gateway data-plane consumes them yet**. Spec 2 wires the chain in alongside the first real transform.

---

## Architecture Overview

The provider remains the transport boundary (Plan B locked). On top of it the frame layer is pure decoding, owned by `@vnext/protocols`:

```
bytes (Response.body)
  │
  ▼  parseSSEStream                (common/stream)
SseFrame { data, event? }
  │
  ▼  parseTargetStreamFrames<T>   (common/stream)
{ type:'event', data:T, frame:SseFrame } | { type:'done' }
  │
  ▼  parseChatCompletionsStream / parseMessagesStream / parseResponsesStream
ProtocolFrame<XxxStreamEvent> = EventFrame<XxxStreamEvent> | DoneFrame
```

`ExecuteResult<T>` is a three-state carrier (events / upstream-error / internal-error) co-located with the frame types; it carries **no telemetry fields** in this spec (deferred to Spec 3).

The interceptor framework gains type aliases per endpoint that close `Interceptor<...>` over `ExecuteResult<ProtocolFrame<TEvent>>`. `runInterceptors` is unchanged (already generic).

---

## File Structure

### New files in `@vnext/protocols`

| Path | Responsibility |
|---|---|
| `src/common/sse.ts` | `SseFrame`, `SseCommentFrame`, `ProtocolFrame<T>`, `EventFrame<T>`, `DoneFrame`, constructors |
| `src/common/result.ts` | `ExecuteResult<T>`, three-state union + constructors / `readUpstreamError` / `upstreamErrorToResponse` |
| `src/common/stream/parse-sse.ts` | `parseSSEStream(body, options): AsyncGenerator<SseFrame>` — line buffering, abort signal, `event:` header capture |
| `src/common/stream/parse-events.ts` | `parseTargetStreamFrames<TEvent>(sse, { protocol, malformedJsonEventName? })` — `[DONE]` handling, JSON parse + protocol-tagged error |
| `src/chat/stream.ts` | `parseChatCompletionsStream` — wraps `parseTargetStreamFrames`; throws on mid-stream `{error}` payload |
| `src/messages/stream.ts` | `parseMessagesStream` — passthrough wrapper, no protocol-level error detection (Anthropic carries errors as terminal events, not mid-stream) |
| `src/responses/stream.ts` | `parseResponsesStream` — passthrough + protocol-level normalization (see "Responses normalization" below) |

### Modified files

| Path | Change |
|---|---|
| `src/common/index.ts` | Re-export sse / result / stream utilities |
| `src/chat/index.ts` | Re-export `parseChatCompletionsStream`, `ParseChatCompletionsStreamOptions` |
| `src/messages/index.ts` | Re-export `parseMessagesStream`, `ParseMessagesStreamOptions` |
| `src/responses/index.ts` | Re-export `parseResponsesStream`, `ParseResponsesStreamOptions` |
| `vnext/packages/interceptor/src/index.ts` | Add `ChatCompletionsStreamInterceptor`, `MessagesStreamInterceptor`, `ResponsesStreamInterceptor` type aliases. No runtime change. |

### Test files (unit only — `bun test` in each package)

| Path | Coverage |
|---|---|
| `src/common/stream/__tests__/parse-sse.test.ts` | line buffering, blank-line dispatch, multi-line `data:` continuation, `event:` header capture, abort cancels reader |
| `src/common/stream/__tests__/parse-events.test.ts` | `[DONE]` sentinel terminates, malformed JSON throws with `protocol:` prefix, `malformedJsonEventName` filter |
| `src/chat/__tests__/stream.test.ts` | passthrough events, mid-stream `{error:{message}}` throws, `[DONE]` yields `doneFrame` |
| `src/messages/__tests__/stream.test.ts` | passthrough events, `[DONE]` yields `doneFrame` |
| `src/responses/__tests__/stream.test.ts` | sequence_number stamping, `ping` skipped, fast-path terminal expands via `responsesResultToEvents`, `event:` header reattached when JSON omits `type` |

**No data-plane tests in this spec.** The frame layer is pure / standalone; no integration to verify.

---

## Type Definitions

### `protocols/common/sse.ts`

```ts
export interface SseFrame { readonly data: string; readonly event?: string }
export interface SseCommentFrame { readonly comment: string }
export const sseFrame = (data: string, event?: string): SseFrame =>
  event === undefined ? { data } : { data, event }
export const sseCommentFrame = (comment: string): SseCommentFrame => ({ comment })

export interface EventFrame<TEvent> { readonly type: 'event'; readonly event: TEvent }
export interface DoneFrame { readonly type: 'done' }
export type ProtocolFrame<TEvent> = EventFrame<TEvent> | DoneFrame

export const eventFrame = <TEvent>(event: TEvent): EventFrame<TEvent> => ({ type: 'event', event })
export const doneFrame = (): DoneFrame => ({ type: 'done' })
```

### `protocols/common/result.ts` (裁剪式 — no telemetry)

```ts
export interface EventResult<T> {
  readonly type: 'events'
  readonly events: AsyncIterable<T>
}
export interface UpstreamErrorResult {
  readonly type: 'upstream-error'
  readonly status: number
  readonly headers: Headers
  readonly body: Uint8Array
}
export interface InternalErrorResult {
  readonly type: 'internal-error'
  readonly status: number
  readonly error: Error
}
export type ExecuteResult<T> = EventResult<T> | UpstreamErrorResult | InternalErrorResult

export const eventResult = <T>(events: AsyncIterable<T>): EventResult<T> =>
  ({ type: 'events', events })
export const internalErrorResult = (status: number, error: Error): InternalErrorResult =>
  ({ type: 'internal-error', status, error })
export const readUpstreamError = async (response: Response): Promise<UpstreamErrorResult> => ({
  type: 'upstream-error',
  status: response.status,
  headers: new Headers(response.headers),
  body: new Uint8Array(await response.arrayBuffer()),
})
export const upstreamErrorToResponse = (error: UpstreamErrorResult): Response =>
  new Response(error.body.slice().buffer, { status: error.status, headers: new Headers(error.headers) })
```

### `interceptor/src/index.ts` additions

```ts
import type { ProtocolFrame, ExecuteResult } from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'
import type { MessagesStreamEvent } from '@vnext/protocols/messages'
import type { ResponsesStreamEvent } from '@vnext/protocols/responses'

export type ChatCompletionsStreamInterceptor =
  Interceptor<Invocation, RequestContext, ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>>
export type MessagesStreamInterceptor =
  Interceptor<Invocation, RequestContext, ExecuteResult<ProtocolFrame<MessagesStreamEvent>>>
export type ResponsesStreamInterceptor =
  Interceptor<Invocation, RequestContext, ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>
```

`CopilotInterceptor = Interceptor<Invocation, RequestContext, Response>` is retained for non-streaming endpoints and payload-side chains.

---

## Per-Protocol Parser Contracts

### chat-completions
- Wraps `parseTargetStreamFrames<ChatCompletionsStreamEvent>` with `protocol: 'Chat Completions'`.
- For each event frame: run `chatCompletionsErrorPayloadMessage(event)`; if it returns a string, throw `Error('Upstream Chat Completions SSE error: ' + msg)`.
- `[DONE]` → yield `doneFrame()` and return.

### messages
- Wraps `parseTargetStreamFrames<MessagesStreamEvent>` with `protocol: 'Messages'`, `malformedJsonEventName: 'message'`.
- Pure passthrough. Anthropic emits `error` as a typed terminal event in the stream, not as an out-of-band wrapper, so no extra detection needed at the frame layer.
- `[DONE]` → `doneFrame()`.

### responses
Three protocol-level normalizations carried verbatim from reference:

1. **`event:` header reattach** — when JSON body omits `type` but SSE `event:` header is present, project it onto the event.
2. **`sequence_number` sequencer** — adopt upstream values when present (advance counter past them); fill in monotonic values when missing.
3. **`ping` skip** — drop ping frames entirely.
4. **Fast-path terminal expansion** — if a terminal event arrives without any prior content-bearing structured event AND the terminal carries a `response` payload, expand via `responsesResultToEvents()`, skipping wrapper types already sent. (`error` terminals have no payload — passthrough.)

These are **protocol-level** normalizations (defining what a "Responses event stream" *means* downstream), not user-facing transforms. They belong with the parser.

---

## Testing Strategy

Per-package unit tests using `bun test`. Each test:
- Builds a `ReadableStream<Uint8Array>` from a string fixture (`new ReadableStream({ start(c){ c.enqueue(new TextEncoder().encode(...)); c.close() }})`).
- Awaits the generator with `for await`, collects frames, asserts shape.

Type-level checks: rely on `tsc --noEmit` in CI to catch interceptor-alias mistakes; no `expectTypeOf` runtime assertion.

No mocks of `provider.fetch`, no end-to-end smoke — those land in Spec 2 alongside the first transform that exercises the full chain.

---

## Non-Goals (and Deferral Triggers)

1. **No data-plane integration.** `chat-flow/<endpoint>/serve.ts` is **not** modified in this spec. No new `interceptors/` directories under `chat-flow/`. No re-serializer. No passthrough smoke. Spec 2's first transform task wires:
   `payload chain → provider.fetch → parseXxxStream → response chain → respond` end-to-end. Doing this without a transform would be untestable churn.
2. **No transforms.** All 10 missing transforms (6 payload + 4 response) are Spec 2.
3. **No provider change.** `provider.fetch → Response` unchanged.
4. **No telemetry channel.** `EventResult<T>` carries only `events`. vNext's existing `conversation-attempt.ts` keeps measuring latency / tracking usage via closure-bound `apiKeyId`/`model`/`upstream` against the wire response.
   **Trigger to lift:** introduction of an interceptor that mutates upstream binding mid-stream (retry-cyber-policy / server-tool-shim style). At that point closure params no longer match the actual upstream that produced bytes; Spec 3 adds optional `modelIdentity? / performance? / finalMetadata?` fields as a non-breaking union extension.
5. **No `runInterceptors` change.**

---

## Migration Impact

- **Plan B compatibility:** zero — provider interface untouched.
- **Existing observability tee paths in chat-flow:** untouched — they still operate on `Response.body`.
- **Existing payload-side interceptors / non-streaming flows:** untouched.
- **New surface that downstream Spec 2 / Spec 3 will consume:** `parseXxxStream`, `ProtocolFrame<T>`, `ExecuteResult<T>`, three interceptor type aliases.

---

## Open Questions

None. Architecture decisions locked: ExecuteResult 裁剪式, physical layering D, three-spec split, telemetry deferred to Spec 3 with documented trigger, parser scope per protocol confirmed against reference implementation.
