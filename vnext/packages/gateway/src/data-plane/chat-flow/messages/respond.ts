// vnext/packages/gateway/src/data-plane/chat-flow/messages/respond.ts
/**
 * Anthropic Messages response renderer.
 *
 * Converts the {@link MessagesAttemptResult} (events / upstream-error /
 * internal-error from `ExecuteResult` plus the bridged-response sentinel) into
 * a single `Response` for the client. SSE streaming is rendered frame-by-frame
 * via {@link messagesProtocolFrameToSSEFrame}; non-streaming requests drain to
 * a reassembled `MessagesResult` JSON envelope. The bridged-response branch
 * hands the legacy `dispatch()` `Response` back unchanged.
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
 * — the union is part of the chat-flow public contract, not the leaf's
 * implementation.
 */
export type RespondMessagesInput =
  | ExecuteResult<ProtocolFrame<MessagesStreamEvent>>
  | { readonly kind: 'bridged-response'; readonly response: Response }

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
  const events = state ? consumeWithState(result.events, state) : result.events
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
    const reassembled = await collectMessagesProtocolEventsToResult(events)
    if (state && options.telemetryCtx) {
      waitUntil(persistFromEventResult(result, state, options.telemetryCtx))
    }
    return Response.json(reassembled)
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

const isBridgedResponse = (
  result: RespondMessagesInput,
): result is { readonly kind: 'bridged-response'; readonly response: Response } =>
  'kind' in result && result.kind === 'bridged-response'

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
): Promise<Response> => {
  // bridged-response is the legacy `dispatch()` short-circuit from
  // attempt.ts; the wrapped Response is already client-shaped.
  if (isBridgedResponse(result)) return result.response
  return await renderExecuteResult(result, options)
}
