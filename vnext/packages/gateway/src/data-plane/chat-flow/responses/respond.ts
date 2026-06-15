// vnext/packages/gateway/src/data-plane/chat-flow/responses/respond.ts
/**
 * /v1/responses response renderer.
 *
 * Mirrors `messages/respond.ts` but adapted for the Responses lifecycle:
 *   - SSE frames carry named events (`event: <event.type>\ndata: <json>\n\n`)
 *     with no `[DONE]` terminator (`response.completed`/`incomplete`/`failed`
 *     is the terminator);
 *   - Model-key correction reads from `event.response.model` (per
 *     `response.created.response.model` and the terminal lifecycle envelope);
 *   - Upstream-error envelope is the OpenAI Responses shape
 *     (`{error: {type, message, ...}}`), produced by
 *     `repackageUpstreamError(res, 'responses')`;
 *   - Non-streaming branch reassembles the frames into a `ResponsesResult`
 *     JSON envelope via `collectResponsesProtocolEventsToResult`.
 *
 * Snapshot sidecars (`attachStreamSidecar` / `attachNonStreamSidecar`) are
 * driven separately from this module — they tee the rendered Response and
 * persist a post-turn snapshot through `getResponsesStore()`, NOT through
 * the new telemetry channel. The sidecar must NOT touch `finalMetadata` or
 * `__interceptorReplaced`. respond.ts therefore returns a fully-rendered
 * Response and exposes the `mergedInputItems` so http.ts can wire
 * sidecar attachment in one place.
 *
 * Reference: messages/respond.ts (Spec 3 Part 3 Task 2).
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
import type { ResponsesStreamEvent } from '@vnext/protocols/responses'
import { repackageUpstreamError } from '../../errors/repackage'
import {
  SourceStreamState,
  eventResultMetadata,
  recordPerformance,
  recordUsage,
} from '../shared/respond-telemetry.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { collectResponsesProtocolEventsToResult } from './events/reassemble.ts'
import { responsesProtocolFrameToSSEFrame } from './events/to-sse.ts'

export interface RespondResponsesOptions {
  readonly wantsStream: boolean
  /** Linked controller for downstream client cancel; same plumbing as messages. */
  readonly downstreamAbortController?: AbortController
  /** Optional — when provided, respond.ts persists usage + perf rows. */
  readonly telemetryCtx?: TelemetryRequestContext
}

/**
 * Mirrors {@link ResponsesAttemptResult} from `./attempt.ts`. Declared inline
 * so this module stays decoupled from the attempt surface — the union is part
 * of the chat-flow public contract, not the leaf's implementation.
 */
export type RespondResponsesInput =
  | ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
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
 * captured into `SourceStreamState`. Throws are propagated AFTER flagging
 * the state as failed so respond-telemetry's `recordPerformance` writes
 * `failed=true`. Probes `event.model`, `event.response.model`, and
 * `event.message.model` for a single generator that works across protocols
 * even when an upstream emits an unexpected shape (defence in depth, same
 * as messages/respond.ts).
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
 * Persists usage + performance rows from a drained `EventResult`. Prefers
 * the interceptor-replaced `finalMetadata` over `result.modelIdentity` so
 * an interceptor that replaces the stream (the image-generation shortcut)
 * gets its own corrected identity. Otherwise the model key observed
 * in-stream supersedes the binding-time guess.
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
 * Mid-stream errors must still terminate with a well-formed SSE record so
 * the client parser doesn't hang waiting for the next chunk. Responses'
 * `error` event shape is `{type: 'error', message, ...}` with the SSE
 * `event: error` name.
 */
const renderEventsAsSSE = (
  result: EventResult<ProtocolFrame<ResponsesStreamEvent>>,
  options: RespondResponsesOptions,
): Response => {
  const state = options.telemetryCtx
    ? new SourceStreamState(result.modelIdentity.modelKey)
    : null
  const events = state ? consumeWithState(result.events, state) : result.events
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of events) {
          const sse = responsesProtocolFrameToSSEFrame(frame)
          if (sse !== null) controller.enqueue(encodeSseFrame(sse))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        controller.enqueue(
          encodeSseFrame(
            sseFrame(JSON.stringify({ type: 'error', message }), 'error'),
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
 * `ResponsesResult` envelope and emit it as JSON. Any reassembly error
 * surfaces as a 502 with the OpenAI-shaped `{error: {type, message}}`
 * envelope. Telemetry persistence runs in both branches.
 */
const renderEventsAsJson = async (
  result: EventResult<ProtocolFrame<ResponsesStreamEvent>>,
  options: RespondResponsesOptions,
): Promise<Response> => {
  const state = options.telemetryCtx
    ? new SourceStreamState(result.modelIdentity.modelKey)
    : null
  const events = state ? consumeWithState(result.events, state) : result.events
  try {
    const reassembled = await collectResponsesProtocolEventsToResult(events)
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
      { error: { type: 'api_error', message } },
      { status: 502 },
    )
  }
}

const isBridgedResponse = (
  result: RespondResponsesInput,
): result is { readonly kind: 'bridged-response'; readonly response: Response } =>
  'kind' in result && result.kind === 'bridged-response'

/**
 * Repackage an upstream non-2xx body as a Responses-shaped error envelope.
 * Uses `repackageUpstreamError(res, 'responses')` for shape parity with the
 * legacy `dispatch()` path. The performance row is fired-and-forgotten via
 * `waitUntil` so a slow repo write never blocks the client response.
 */
const renderUpstreamError = async (
  result: UpstreamErrorResult,
  options: RespondResponsesOptions,
): Promise<Response> => {
  if (options.telemetryCtx) {
    waitUntil(recordPerformance(options.telemetryCtx, result.performance, true))
  }
  return await repackageUpstreamError(upstreamErrorToResponse(result), 'responses')
}

const renderExecuteResult = async (
  result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>,
  options: RespondResponsesOptions,
): Promise<Response> => {
  if (result.type === 'upstream-error') return await renderUpstreamError(result, options)
  if (result.type === 'internal-error') {
    if (options.telemetryCtx) {
      // recordPerformance no-ops when `result.performance` is undefined
      // (pre-binding errors per spec §6.2 deliberately omit perf rows).
      waitUntil(recordPerformance(options.telemetryCtx, result.performance, true))
    }
    return Response.json(
      { error: { type: 'api_error', message: result.error.message } },
      { status: result.status },
    )
  }
  // result.type === 'events'
  return options.wantsStream
    ? renderEventsAsSSE(result, options)
    : await renderEventsAsJson(result, options)
}

export const respondResponses = async (
  result: RespondResponsesInput,
  options: RespondResponsesOptions,
): Promise<Response> => {
  // bridged-response is the legacy `dispatch()` short-circuit from
  // attempt.ts; the wrapped Response is already client-shaped.
  if (isBridgedResponse(result)) return result.response
  return await renderExecuteResult(result, options)
}
