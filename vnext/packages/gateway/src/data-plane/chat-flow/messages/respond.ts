// vnext/packages/gateway/src/data-plane/chat-flow/messages/respond.ts
/**
 * Anthropic Messages response renderer.
 *
 * Converts the {@link MessagesAttemptResult} (events / upstream-error /
 * internal-error from `LlmExecuteResult`) into a single `Response` for the
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
 *   - Upstream-error bodies are forwarded verbatim by
 *     `forwardUpstreamError(res, 'messages')`, not re-minted. A cross-protocol
 *     binding therefore hands an Anthropic client an OpenAI-shaped body — both
 *     nest the text at `error.message`, which is where the SDK reads it.
 *
 * Reference: copilot-gateway/packages/gateway/src/data-plane/llm/messages/respond.ts
 */
import { waitUntil } from '@vibe-core/platform'
import {
  upstreamErrorToResponse,
  type LlmEventResult,
  type LlmExecuteResult,
  type UpstreamErrorResult,
} from '@vibe-llm/protocols/common'
import {
  eventFrame,
  sseFrame,
  type ProtocolFrame,
  type SseFrame,
} from '@vibe-core/result'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'
import { forwardUpstreamError } from '../../errors/forward'
import {
  SourceStreamState,
  eventResultMetadata,
  finalModelIdentity,
  normalizeStreamEventModel,
  performanceTargetFromTranslatorPair,
  recordPerformance,
  recordUsage,
} from '../shared/respond-telemetry.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { collectMessagesProtocolEventsToResult } from './events/reassemble.ts'
import { messagesProtocolFrameToSSEFrame } from './events/to-sse.ts'
import { MESSAGES_KEEPALIVE_FRAME, startSseKeepalive } from '../shared/sse-keepalive.ts'
import { collectChatCompletionsProtocolEventsToResult } from '../chat-completions/events/to-result'
import { collectResponsesProtocolEventsToResult } from '../responses/events/reassemble'
import type { DumpAccumulator } from '../../../shared/dump/accumulator.ts'

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
  /**
   * Optional per-request dump accumulator. When present, respond.ts calls
   * mid-flight hooks (`frame` per protocol frame, `success` on completion,
   * `error` on upstream non-2xx, `failed` on internal/mid-stream errors).
   * Kit auto-tees the terminal Response into `finalize` outside this layer.
   */
  readonly dump?: DumpAccumulator | null
}

/**
 * Mirrors {@link MessagesAttemptResult} from `./attempt.ts`. Declared inline
 * rather than imported to keep this module decoupled from the attempt surface
 * — the alias is part of the chat-flow public contract, not the leaf's
 * implementation.
 */
export type RespondMessagesInput = LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>

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
  dump?: DumpAccumulator | null,
): AsyncGenerator<ProtocolFrame<T>> {
  try {
    for await (const frame of events) {
      if (frame.type === 'event') {
        const evObj = frame.event as {
          model?: unknown
          modelVersion?: unknown
          response?: { model?: unknown }
          message?: { model?: unknown }
        }
        state.rememberModelKey(evObj.model ?? evObj.modelVersion ?? evObj.response?.model ?? evObj.message?.model)
        state.rememberFailure(frame.event, 'messages')
        const normalized = normalizeStreamEventModel(frame.event, state.publicModel)
        state.rememberUsage(normalized)
        const output = normalized === frame.event ? frame : { ...frame, event: normalized as T }
        dump?.frame(output as ProtocolFrame<unknown>)
        yield output
        continue
      }
      dump?.frame(frame as ProtocolFrame<unknown>)
      yield frame
    }
  } catch (err) {
    state.failedAfter()
    dump?.failed(err)
    throw err
  }
}

/**
 * Persists usage + performance rows from a drained `LlmEventResult`. Prefers the
 * interceptor-replaced `finalMetadata` over `result.modelIdentity` so a
 * downstream interceptor that swaps the stream gets its own corrected
 * identity. Otherwise the model key observed in-stream supersedes the
 * binding-time guess.
 */
async function persistFromEventResult<T>(
  result: LlmEventResult<ProtocolFrame<T>>,
  state: SourceStreamState,
  telemetryCtx: TelemetryRequestContext | undefined,
  dump?: DumpAccumulator | null,
): Promise<void> {
  const md = await eventResultMetadata(result)
  const finalIdentity = result.finalMetadata
    ? md.modelIdentity
    : finalModelIdentity(md.modelIdentity, state.modelKey, result.resolveModelIdentity)
  if (dump) {
    if (state.failed) dump.failed('messages stream failed')
    else dump.success(finalIdentity, state.usage.tokens)
  }
  if (telemetryCtx) {
    await recordUsage(telemetryCtx, finalIdentity, state.usage.tokens)
    await recordPerformance(
      telemetryCtx,
      md.performance,
      state.failed,
      undefined,
      performanceTargetFromTranslatorPair(finalIdentity),
    )
  }
}

// Cross-protocol streaming: apply translator at SSE-time so the SSE encoder
// sees source-shape (messages) frames; same-protocol falls through unchanged.
//
// When `translateEvents` is set on the LlmEventResult, `result.events` carries
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
  translateEvents: NonNullable<LlmEventResult<unknown>['translateEvents']>,
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
  result: LlmEventResult<ProtocolFrame<MessagesStreamEvent>>,
  options: RespondMessagesOptions,
): Response => {
  const state = new SourceStreamState(result.modelIdentity.modelKey, result.modelIdentity.model)
  // Cross-protocol streaming: apply translator at SSE-time so the SSE encoder
  // sees source-shape frames; same-protocol falls through unchanged.
  const upstreamFrames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>> = result.translateEvents
    ? applyTranslatorEventsForStreaming(
        result.events as unknown as AsyncIterable<ProtocolFrame<unknown>>,
        result.translateEvents,
        options.downstreamAbortController?.signal,
        result.modelIdentity.model,
      )
    : result.events
  const events = consumeWithState(upstreamFrames, state, options.dump)
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const keepalive = startSseKeepalive(controller, MESSAGES_KEEPALIVE_FRAME)
      try {
        for await (const frame of events) {
          const sse = messagesProtocolFrameToSSEFrame(frame)
          if (sse !== null) controller.enqueue(encodeSseFrame(sse))
          keepalive.touch()
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        options.dump?.failed(message)
        controller.enqueue(
          encodeSseFrame(
            sseFrame(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }), 'error'),
          ),
        )
      } finally {
        keepalive.stop()
        controller.close()
        if (state && (options.telemetryCtx || options.dump)) {
          waitUntil(persistFromEventResult(result, state, options.telemetryCtx, options.dump))
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
  result: LlmEventResult<ProtocolFrame<MessagesStreamEvent>>,
  options: RespondMessagesOptions,
): Promise<Response> => {
  const state = new SourceStreamState(result.modelIdentity.modelKey, result.modelIdentity.model)
  const events = consumeWithState(result.events, state, options.dump)
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
          model: state.publicModel,
        })
      : reassembled
    if (state && (options.telemetryCtx || options.dump)) {
      waitUntil(persistFromEventResult(result, state, options.telemetryCtx, options.dump))
    }
    return Response.json(finalBody)
  } catch (err) {
    state.failedAfter()
    if (state && (options.telemetryCtx || options.dump)) {
      waitUntil(persistFromEventResult(result, state, options.telemetryCtx, options.dump))
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
// renderer only handles `LlmExecuteResult` variants.

/**
 * Forward an upstream non-2xx body untouched via `forwardUpstreamError`.
 * The performance row is fired-and-forgotten via `waitUntil` so a slow repo
 * write never blocks the client response.
 */
const renderUpstreamError = async (
  result: UpstreamErrorResult,
  options: RespondMessagesOptions,
): Promise<Response> => {
  if (options.telemetryCtx) {
    waitUntil(recordPerformance(options.telemetryCtx, result.performance, true, undefined, result.targetApi))
  }
  options.dump?.error('upstream', result.performance?.upstream ?? undefined)
  return await forwardUpstreamError(upstreamErrorToResponse(result), 'messages')
}

const renderExecuteResult = async (
  result: LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>,
  options: RespondMessagesOptions,
): Promise<Response> => {
  if (result.type === 'upstream-error') return await renderUpstreamError(result, options)
  if (result.type === 'internal-error') {
    if (options.telemetryCtx) {
      // recordPerformance no-ops when `result.performance` is undefined
      // (pre-binding errors per spec §6.2 deliberately omit perf rows).
      waitUntil(recordPerformance(options.telemetryCtx, result.performance, true))
    }
    options.dump?.failed(result.error.message)
    // Root parity: 4xx-class internal errors (e.g. unknown model → 404) use
    // `invalid_request_error`; only 5xx use `api_error`. SDKs branch on
    // error.type, so the distinction matters for user-facing handling.
    const errType = result.status >= 400 && result.status < 500 ? 'invalid_request_error' : 'api_error'
    return Response.json(
      { type: 'error', error: { type: errType, message: result.error.message } },
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
