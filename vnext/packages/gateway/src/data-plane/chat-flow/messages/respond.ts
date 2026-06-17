// vnext/packages/gateway/src/data-plane/chat-flow/messages/respond.ts
/**
 * Anthropic Messages response renderer.
 *
 * Converts the {@link MessagesAttemptResult} (events / upstream-error /
 * internal-error from `ExecuteResult`) into a single `Response` for the
 * client. SSE streaming is rendered frame-by-frame via
 * {@link messagesProtocolFrameToSSEFrame}; non-streaming requests drain to
 * a reassembled `MessagesResult` JSON envelope.
 *
 * Telemetry phase: when `telemetryCtx` is supplied, the renderer drains each
 * frame through a `SourceStreamState` (model-key correction + usage capture +
 * mid-stream-fail flag) then `waitUntil`s `recordUsage` + `recordPerformance`
 * so dashboards keep working even when the client disconnects mid-stream. The
 * field is optional so unit tests can skip telemetry entirely.
 *
 * Mirrors `chat-completions/respond.ts` but adapted for messages-specific
 * concerns:
 *   - SSE encoding has named events (`event: <type>`); no `[DONE]` terminator
 *     (`message_stop` is the terminator by convention)
 *   - Model-key correction reads from `event.message.model` (the `message_start`
 *     frame), in addition to the chat-completions/responses `event.model` /
 *     `event.response.model` fallbacks
 *   - Upstream-error envelope shape: `{type: 'error', error: {type, message}}`
 *     (handled by `repackageUpstreamError(res, 'messages')`)
 *
 * Reference: copilot-gateway/packages/gateway/src/data-plane/llm/messages/respond.ts
 */
import { waitUntil } from '@vnext/platform'
import {
  upstreamErrorToResponse,
  eventFrame,
  sseFrame,
  type EventResult,
  type ExecuteResult,
  type ProtocolFrame,
  type SseFrame,
  type UpstreamErrorResult,
} from '@vnext/protocols/common'
import type { MessagesStreamEvent } from '@vnext/protocols/messages'
import { repackageUpstreamError } from '../../errors/repackage'
import {
  SourceStreamState,
  eventResultMetadata,
  recordPerformance,
  recordUsage,
} from '../shared/respond-telemetry.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { collectMessagesProtocolEventsToResult } from './events/reassemble.ts'
import { messagesProtocolFrameToSSEFrame } from './events/to-sse.ts'
import { collectChatCompletionsProtocolEventsToResult } from '../chat-completions/events/to-result'
import { collectResponsesProtocolEventsToResult } from '../responses/events/reassemble'

export interface RespondMessagesOptions {
  readonly wantsStream: boolean
  /**
   * Optional abort signal used to cancel an in-flight SSE source generator
   * when the downstream client disconnects mid-stream. Same plumbing as the
   * chat-completions renderer: serve.ts pairs this with the same controller it
   * injects via `RequestContext.downstreamAbortSignal`, so a client cancel
   * unwinds the upstream socket via `provider.fetch` + `parseMessagesStream`.
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
 * Mirrors {@link MessagesAttemptResult} from `./attempt.ts`. Declared inline
 * rather than imported to keep this module decoupled from the attempt surface
 * — the alias is part of the chat-flow public contract, not the leaf's
 * implementation.
 */
export type RespondMessagesInput = ExecuteResult<ProtocolFrame<MessagesStreamEvent>>

const SSE_TEXT_ENCODER = new TextEncoder()

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
 * `failed=true`. Messages places the corrected model key inside
 * `message_start.message.model` — `chat-completions` reads `event.model`,
 * `responses` reads `event.response.model`. We probe all three so the same
 * generator works across protocols if the upstream emits an unexpected shape.
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
 * Persists usage + performance rows from a drained `EventResult`. Prefers the
 * interceptor-replaced `finalMetadata` over `result.modelIdentity` so a
 * downstream interceptor that swaps the stream gets its own corrected
 * identity. Otherwise the model key observed in-stream supersedes the
 * binding-time guess.
 */
async function persistFromEventResult<T>(
  result: EventResult<ProtocolFrame<T>>,
  state: SourceStreamState,
  telemetryCtx: TelemetryRequestContext,
): Promise<void> {
  const md = await eventResultMetadata(result)
  const finalIdentity = result.finalMetadata
    ? md.modelIdentity
    : { ...md.modelIdentity, modelKey: state.modelKey }
  await recordUsage(telemetryCtx, finalIdentity, state.usage.tokens)
  await recordPerformance(telemetryCtx, md.performance, state.failed)
}

// Cross-protocol streaming: apply translator at SSE-time so the SSE encoder
// sees source-shape (messages) frames; same-protocol falls through unchanged.
//
// When `translateEvents` is set on the EventResult, `result.events` carries
// HUB-shape frames (e.g. `ProtocolFrame<ResponsesStreamEvent>` for
// messages→responses, or `ProtocolFrame<ChatCompletionsStreamEvent>` for
// messages→chat_completions). Before SSE encoding we:
//   1. unwrap `ProtocolFrame<HubFrame>` → bare hub events (yield `frame.event`
//      for `frame.type === 'event'`),
//   2. run them through the translator (`translateResponsesToMessagesSSE`,
//      `translateChatToMessagesSSE`),
//   3. re-wrap each yielded source event as a `ProtocolFrame<MessagesStreamEvent>`.
// No `doneFrame()` is appended — messages SSE terminates with `message_stop`
// (the natural terminator emitted by the translator), not a synthetic sentinel.
async function* applyTranslatorEventsForStreaming(
  hubFrames: AsyncIterable<ProtocolFrame<unknown>>,
  translateEvents: NonNullable<EventResult<unknown>['translateEvents']>,
  signal: AbortSignal | undefined,
  model: string | undefined,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
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
  const translated = translateEvents(unwrap(), ctx) as AsyncIterable<MessagesStreamEvent>
  for await (const ev of translated) yield eventFrame(ev) as ProtocolFrame<MessagesStreamEvent>
}

/**
 * Mid-stream errors must still terminate with a well-formed SSE record so the
 * client parser doesn't hang waiting for the next chunk. Anthropic's `error`
 * event shape is `{type: 'error', error: {type, message}}` with the `event:
 * error` SSE name.
 */
const renderEventsAsSSE = (
  result: EventResult<ProtocolFrame<MessagesStreamEvent>>,
  options: RespondMessagesOptions,
): Response => {
  const state = options.telemetryCtx
    ? new SourceStreamState(result.modelIdentity.modelKey)
    : null
  // Cross-protocol streaming: apply translator at SSE-time so the SSE encoder
  // sees source-shape frames; same-protocol falls through unchanged.
  const upstreamFrames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>> = result.translateEvents
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
          const sse = messagesProtocolFrameToSSEFrame(frame)
          if (sse !== null) controller.enqueue(encodeSseFrame(sse))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        controller.enqueue(
          encodeSseFrame(
            sseFrame(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }), 'error'),
          ),
        )
      } finally {
        controller.close()
        if (state && options.telemetryCtx) {
          waitUntil(persistFromEventResult(result, state, options.telemetryCtx))
        }
      }
    },
    cancel(_reason) {
      options.downstreamAbortController?.abort()
    },
  })
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * Non-streaming branch: drain the protocol-frame stream into a single
 * `MessagesResult` envelope and emit it as JSON. Any reassembly error surfaces
 * as a 502 with the Anthropic-shaped `{type: 'error', error: {type: 'api_error',
 * message}}` envelope. Telemetry persistence runs in both branches.
 *
 * Cross-protocol attempts (Spec 6 Part 3): when `translatorPair` is present,
 * the events array carries HUB-shaped frames. Reassemble using the hub's
 * reassembler, then hand the hub-shaped JSON to `translateBody` to convert
 * back to the messages JSON envelope before responding. Same-protocol attempts
 * leave `translatorPair`/`translateBody` undefined and use the messages reassembler.
 */
const renderEventsAsJson = async (
  result: EventResult<ProtocolFrame<MessagesStreamEvent>>,
  options: RespondMessagesOptions,
): Promise<Response> => {
  const state = options.telemetryCtx
    ? new SourceStreamState(result.modelIdentity.modelKey)
    : null
  const events = state ? consumeWithState(result.events, state) : result.events
  try {
    // Dispatch reassembly on hub protocol — same-protocol (or absent) →
    // messages reassembler; cross-protocol → hub reassembler so the
    // hub-shaped frames reassemble into a hub-shaped envelope first.
    const hub = result.modelIdentity.translatorPair?.hub
    let reassembled: unknown
    if (hub === 'chat_completions') {
      reassembled = await collectChatCompletionsProtocolEventsToResult(events as never)
    } else if (hub === 'responses') {
      reassembled = await collectResponsesProtocolEventsToResult(events as never)
    } else {
      reassembled = await collectMessagesProtocolEventsToResult(events as never)
    }
    // If a translator-supplied body translator is attached, convert the
    // hub-shaped JSON back to the source (messages) JSON envelope.
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
    return Response.json(
      { type: 'error', error: { type: 'api_error', message } },
      { status: 502 },
    )
  }
}

// The bridged-response sentinel was removed when the cross-protocol
// `dispatch()` bridge was deleted in Spec 3 Part 4. Native cross-protocol
// attempts surface a 501 internal-error result via attempt.ts now, so the
// renderer only handles `ExecuteResult` variants.

/**
 * Repackage an upstream non-2xx body as an Anthropic-shaped error envelope.
 * Uses `repackageUpstreamError(res, 'messages')` for shape parity with the
 * legacy `dispatch()` path. The performance row is fired-and-forgotten via
 * `waitUntil` so a slow repo write never blocks the client response.
 */
const renderUpstreamError = async (
  result: UpstreamErrorResult,
  options: RespondMessagesOptions,
): Promise<Response> => {
  if (options.telemetryCtx) {
    waitUntil(recordPerformance(options.telemetryCtx, result.performance, true))
  }
  return await repackageUpstreamError(upstreamErrorToResponse(result), 'messages')
}

const renderExecuteResult = async (
  result: ExecuteResult<ProtocolFrame<MessagesStreamEvent>>,
  options: RespondMessagesOptions,
): Promise<Response> => {
  if (result.type === 'upstream-error') return await renderUpstreamError(result, options)
  if (result.type === 'internal-error') {
    if (options.telemetryCtx) {
      // recordPerformance no-ops when `result.performance` is undefined
      // (pre-binding errors per spec §6.2 deliberately omit perf rows).
      waitUntil(recordPerformance(options.telemetryCtx, result.performance, true))
    }
    return Response.json(
      { type: 'error', error: { type: 'api_error', message: result.error.message } },
      { status: result.status },
    )
  }
  // result.type === 'events'
  return options.wantsStream
    ? renderEventsAsSSE(result, options)
    : await renderEventsAsJson(result, options)
}

export const respondMessages = async (
  result: RespondMessagesInput,
  options: RespondMessagesOptions,
): Promise<Response> => renderExecuteResult(result, options)
