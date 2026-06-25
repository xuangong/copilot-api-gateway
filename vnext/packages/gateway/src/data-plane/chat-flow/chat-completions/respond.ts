// vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts
/**
 * Chat Completions response renderer.
 *
 * Converts the {@link ChatCompletionsAttemptResult} (events / upstream-error /
 * internal-error from `LlmExecuteResult`) into a single `Response` for the
 * client. SSE streaming is rendered frame-by-frame via
 * {@link chatCompletionsProtocolFrameToSSEFrame}; non-streaming requests
 * drain to a reassembled JSON envelope.
 *
 * Telemetry phase: when `telemetryCtx` is supplied, the renderer drains each
 * frame through a `SourceStreamState` (model-key correction + usage capture +
 * mid-stream-fail flag) then `waitUntil`s `recordUsage` + `recordPerformance`
 * so dashboards keep working even when the client disconnects mid-stream. The
 * field is optional so unit tests can skip telemetry entirely.
 *
 * Reference: copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/respond.ts
 */
import { waitUntil } from '@vibe-core/platform'
import {
  upstreamErrorToResponse,
  type LlmEventResult,
  type LlmExecuteResult,
  type UpstreamErrorResult,
} from '@vibe-llm/protocols/common'
import {
  doneFrame,
  eventFrame,
  sseFrame,
  type ProtocolFrame,
  type SseFrame,
} from '@vibe-core/result'
import type { ChatCompletionsStreamEvent } from '@vibe-llm/protocols/chat'
import { repackageUpstreamError } from '../../errors/repackage'
import {
  SourceStreamState,
  eventResultMetadata,
  recordPerformance,
  recordUsage,
} from '../shared/respond-telemetry.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { collectChatCompletionsProtocolEventsToResult } from './events/to-result'
import { chatCompletionsProtocolFrameToSSEFrame } from './events/to-sse'
import { collectMessagesProtocolEventsToResult } from '../messages/events/reassemble'
import { collectResponsesProtocolEventsToResult } from '../responses/events/reassemble'

export interface RespondChatCompletionsOptions {
  readonly wantsStream: boolean
  readonly includeUsageChunk: boolean
  /**
   * Optional abort signal used to cancel an in-flight SSE source generator
   * when the downstream client disconnects mid-stream. serve.ts pairs this
   * with the same controller it injects via `RequestContext.downstreamAbortSignal`
   * — when the browser/SDK closes its read end, ReadableStream.cancel() fires,
   * we abort the controller, and the upstream `parseChatCompletionsStream` +
   * `provider.fetch(... , {signal})` chain unwinds. Without this, an abandoned
   * client leaks the upstream socket until the model itself stops streaming.
   */
  readonly downstreamAbortController?: AbortController
  /**
   * Optional — when provided, respond.ts persists usage + performance rows
   * via `recordUsage` + `recordPerformance` (wrapped in `waitUntil` so the
   * client response isn't blocked). Unit tests omit this to skip persistence.
   */
  readonly telemetryCtx?: TelemetryRequestContext
}

/**
 * Mirrors {@link ChatCompletionsAttemptResult} from `./attempt.ts`. Declared
 * inline rather than imported to keep this module decoupled from the attempt
 * surface — the alias is part of the chat-flow public contract, not the
 * leaf's implementation.
 */
export type RespondChatCompletionsInput = LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>

const SSE_TEXT_ENCODER = new TextEncoder()

// Serialises an `SseFrame` to wire bytes. Matches the legacy shape (`event: …`
// then `data: …`, terminated by a blank line) so SDK parsers stay happy.
const encodeSseFrame = (frame: SseFrame): Uint8Array => {
  const lines: string[] = []
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`)
  lines.push(`data: ${frame.data}`)
  return SSE_TEXT_ENCODER.encode(lines.join('\n') + '\n\n')
}

/**
 * Wraps the protocol-frame stream so each frame's usage + reported model are
 * captured into `SourceStreamState`. Throws are propagated AFTER flagging the
 * state as failed so respond-telemetry's `recordPerformance` writes
 * `failed=true`. The `model` extraction matches legacy snapshot-sidecar's
 * pattern (try `event.model`, else `event.response.model`, else
 * `event.message.model`) so dashboards keep showing the corrected key for
 * provider aliasing (e.g. `gpt-4-turbo` → `gpt-4-turbo-2025`).
 */
async function* consumeWithState<T>(
  events: AsyncIterable<ProtocolFrame<T>>,
  state: SourceStreamState,
): AsyncGenerator<ProtocolFrame<T>> {
  try {
    for await (const frame of events) {
      if (frame.type === 'event') {
        state.rememberUsage(frame.event)
        const evObj = frame.event as {
          model?: unknown
          response?: { model?: unknown }
          message?: { model?: unknown }
        }
        state.rememberModelKey(evObj.model ?? evObj.response?.model ?? evObj.message?.model)
      }
      yield frame
    }
  } catch (err) {
    state.failedAfter()
    throw err
  }
}

/**
 * Persists usage + performance rows from a drained `LlmEventResult`. Prefers the
 * interceptor-replaced `finalMetadata` over `result.modelIdentity` so a
 * downstream interceptor that swaps the stream (responses-via-chat, etc.) gets
 * its own corrected identity. Otherwise the model key observed in-stream
 * supersedes the binding-time guess (e.g. provider returns `gpt-4-turbo-2025`
 * instead of the requested `gpt-4-turbo`).
 */
async function persistFromEventResult<T>(
  result: LlmEventResult<ProtocolFrame<T>>,
  state: SourceStreamState,
  telemetryCtx: TelemetryRequestContext,
): Promise<void> {
  const md = await eventResultMetadata(result)
  // Refresh pricing using the corrected modelKey observed by SourceStreamState,
  // unless finalMetadata already supplied a corrected identity (interceptor-
  // replaced streams already know their own identity).
  const finalIdentity = result.finalMetadata
    ? md.modelIdentity
    : { ...md.modelIdentity, modelKey: state.modelKey }
  await recordUsage(telemetryCtx, finalIdentity, state.usage.tokens)
  await recordPerformance(telemetryCtx, md.performance, state.failed)
}

// Mid-stream errors must still terminate with a well-formed SSE record so the
// client parser doesn't hang waiting for the next chunk. We emit a single
// `event: error` frame carrying a minimal `{ error: { message } }` payload
// before closing the controller. When `telemetryCtx` is set, the finally
// block hands off persistence to `waitUntil` so a slow repo write never
// blocks the response close.
//
// Cross-protocol attempts (Spec 6 Part 2 §3.7): when `translateEvents` is set
// on the LlmEventResult, `result.events` carries HUB-shape frames (e.g.
// `ProtocolFrame<ResponsesStreamEvent>` for cc→responses). Before SSE
// encoding we:
//   1. unwrap `ProtocolFrame<HubFrame>` → bare hub events,
//   2. run them through the translator (`translateResponsesToChatSSE`,
//      `translateMessagesToChatSSE`),
//   3. re-wrap each yielded source event as a `ProtocolFrame<ChatCompletionsStreamEvent>`,
//   4. terminate with a `doneFrame()` so the SSE encoder emits `[DONE]`.
// Same-protocol attempts have no `translateEvents` and skip this entirely.
async function* applyTranslatorEventsForStreaming(
  hubFrames: AsyncIterable<ProtocolFrame<unknown>>,
  translateEvents: NonNullable<LlmEventResult<unknown>['translateEvents']>,
  signal: AbortSignal | undefined,
  model: string | undefined,
): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
  async function* unwrap(): AsyncGenerator<unknown> {
    for await (const frame of hubFrames) {
      if (frame.type === 'event') yield frame.event
    }
  }
  const ctx = {
    signal: signal ?? new AbortController().signal,
    fallbackMaxOutputTokens: undefined,
    model,
  }
  const translated = translateEvents(unwrap(), ctx) as AsyncIterable<ChatCompletionsStreamEvent>
  for await (const ev of translated) yield eventFrame(ev) as ProtocolFrame<ChatCompletionsStreamEvent>
  yield doneFrame() as ProtocolFrame<ChatCompletionsStreamEvent>
}

const renderEventsAsSSE = (
  result: LlmEventResult<ProtocolFrame<ChatCompletionsStreamEvent>>,
  options: RespondChatCompletionsOptions,
): Response => {
  const state = options.telemetryCtx
    ? new SourceStreamState(result.modelIdentity.modelKey)
    : null
  // Cross-protocol streaming: apply translator at SSE-time so the SSE encoder
  // sees source-shape frames; same-protocol falls through unchanged.
  const upstreamFrames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>> = result.translateEvents
    ? applyTranslatorEventsForStreaming(
        result.events as unknown as AsyncIterable<ProtocolFrame<unknown>>,
        result.translateEvents,
        options.downstreamAbortController?.signal,
        result.modelIdentity.modelKey,
      )
    : result.events
  const events = state ? consumeWithState(upstreamFrames, state) : upstreamFrames
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of events) {
          const sse = chatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk: options.includeUsageChunk })
          if (sse !== null) controller.enqueue(encodeSseFrame(sse))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        controller.enqueue(encodeSseFrame(sseFrame(JSON.stringify({ error: { message } }), 'error')))
      } finally {
        controller.close()
        if (state && options.telemetryCtx) {
          waitUntil(persistFromEventResult(result, state, options.telemetryCtx))
        }
      }
    },
    // Downstream client closed its read end (browser navigated away, SDK
    // dropped the connection, etc.). Abort the shared controller so the
    // upstream socket — held open by `provider.fetch` + `parseChatCompletionsStream`
    // via the same signal — unwinds promptly instead of waiting for the model
    // to finish.
    cancel(_reason) {
      options.downstreamAbortController?.abort()
    },
  })
  return new Response(body, {
    status: 200,
    // Headers mirror the reference (`copilot-gateway`) shape so reverse
    // proxies (nginx `x-accel-buffering: no`, CDN edges, etc.) don't buffer
    // and SSE clients don't auto-reconnect from a stale cache entry.
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

// Non-streaming branch: drain the protocol-frame stream into a single
// `ChatCompletionsResult` envelope and emit it as JSON. Any reassembly error
// surfaces as a 502 with the same `{ error: { message } }` shape used by the
// internal-error branch. Telemetry persistence runs in both branches.
//
// Cross-protocol attempts (Spec 6 Part 2): when `translatorPair` is present,
// the events array carries HUB-shaped frames (responses or messages frames,
// not chat-completions frames). Reassemble using the hub's reassembler, then
// hand the hub-shaped JSON to `translateBody` to convert back to the source
// (chat_completions) JSON envelope before responding. Same-protocol attempts
// leave `translatorPair`/`translateBody` undefined and fall through to the
// chat-completions reassembler unchanged.
const renderEventsAsJson = async (
  result: LlmEventResult<ProtocolFrame<ChatCompletionsStreamEvent>>,
  options: RespondChatCompletionsOptions,
): Promise<Response> => {
  const state = options.telemetryCtx
    ? new SourceStreamState(result.modelIdentity.modelKey)
    : null
  const events = state ? consumeWithState(result.events, state) : result.events
  try {
    // Dispatch reassembly on hub protocol — same-protocol (or absent) →
    // chat-completions reassembler; cross-protocol → hub reassembler so the
    // hub-shaped frames reassemble into a hub-shaped envelope first.
    const hub = result.modelIdentity.translatorPair?.hub
    let reassembled: unknown
    if (hub === 'messages') {
      reassembled = await collectMessagesProtocolEventsToResult(events as never)
    } else if (hub === 'responses') {
      reassembled = await collectResponsesProtocolEventsToResult(events as never)
    } else {
      reassembled = await collectChatCompletionsProtocolEventsToResult(events)
    }
    // If a translator-supplied body translator is attached, convert the
    // hub-shaped JSON back to the source (chat_completions) JSON envelope.
    // The signal is sourced from the downstream abort controller when
    // available so a slow translateBody unwinds promptly on client cancel;
    // otherwise we hand it a fresh (never-aborted) controller's signal.
    const finalBody = result.translateBody
      ? await result.translateBody(reassembled, {
          signal: options.downstreamAbortController?.signal ?? new AbortController().signal,
          fallbackMaxOutputTokens: undefined,
          model: result.modelIdentity.modelKey,
        })
      : reassembled
    if (state && options.telemetryCtx) {
      waitUntil(persistFromEventResult(result, state, options.telemetryCtx))
    }
    return Response.json(finalBody)
  } catch (err) {
    if (state) state.failedAfter()
    if (state && options.telemetryCtx) {
      waitUntil(persistFromEventResult(result, state, options.telemetryCtx))
    }
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: { message } }, { status: 502 })
  }
}

// The bridged-response sentinel was removed when the cross-protocol
// `dispatch()` bridge was deleted in Spec 3 Part 4. Native cross-protocol
// attempts surface a 501 internal-error result via attempt.ts now, so the
// renderer only handles `LlmExecuteResult` variants.

// Upstream errors carry the raw provider body verbatim; the OpenAI SDK expects
// the `{ error: { type, message, ...code } }` envelope shape. We reuse the
// existing `repackageUpstreamError` helper (sourceApi='chat_completions') so
// the body is normalized identically to the legacy `dispatch()` path — same
// type defaults (`invalid_request_error` for 4xx, `api_error` for 5xx), same
// status preservation. The performance row is fired-and-forgotten via
// `waitUntil` so a slow repo write never blocks the client response.
const renderUpstreamError = async (
  result: UpstreamErrorResult,
  options: RespondChatCompletionsOptions,
): Promise<Response> => {
  if (options.telemetryCtx) {
    waitUntil(recordPerformance(options.telemetryCtx, result.performance, true))
  }
  return await repackageUpstreamError(upstreamErrorToResponse(result), 'chat_completions')
}

const renderExecuteResult = async (
  result: LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>,
  options: RespondChatCompletionsOptions,
): Promise<Response> => {
  if (result.type === 'upstream-error') return await renderUpstreamError(result, options)
  if (result.type === 'internal-error') {
    if (options.telemetryCtx) {
      // recordPerformance no-ops when `result.performance` is undefined
      // (pre-binding errors per spec §6.2 deliberately omit perf rows).
      waitUntil(recordPerformance(options.telemetryCtx, result.performance, true))
    }
    return Response.json({ error: { message: result.error.message } }, { status: result.status })
  }
  // result.type === 'events'
  return options.wantsStream
    ? renderEventsAsSSE(result, options)
    : await renderEventsAsJson(result, options)
}

export const respondChatCompletions = async (
  result: RespondChatCompletionsInput,
  options: RespondChatCompletionsOptions,
): Promise<Response> => renderExecuteResult(result, options)
