import { translateStream } from "../shared/translate-stream"
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
 *   - Upstream-error bodies are forwarded verbatim by
 *     `forwardUpstreamError(res, 'responses')` — the upstream already speaks
 *     this envelope, so re-minting could only drop fields;
 *   - Non-streaming branch reassembles the frames into a `ResponsesResult`
 *     JSON envelope via `collectResponsesProtocolEventsToResult`.
 *
 * Reusable completion awaits the request-scoped snapshot writer before SSE
 * terminal delivery or JSON success. Telemetry remains a separate channel.
 *
 * Reference: messages/respond.ts (Spec 3 Part 3 Task 2).
 */
import { parseSSEStream } from '@vibe-core/result/parse'
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
import { ResponsesFinalOutput, type ResponsesStreamEvent } from '@vibe-llm/protocols/responses'
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
import type { DumpAccumulator } from '../../../shared/dump/accumulator.ts'
import { collectResponsesProtocolEventsToResult } from './events/reassemble.ts'
import { responsesProtocolFrameToSSEFrame } from './events/to-sse.ts'
import { COMMENT_KEEPALIVE_FRAME, startSseKeepalive } from '../shared/sse-keepalive.ts'
import { collectChatCompletionsProtocolEventsToResult } from '../chat-completions/events/to-result'
import { collectMessagesProtocolEventsToResult } from '../messages/events/reassemble'

export interface CompletedResponsesSnapshot {
  readonly id: string
  readonly model?: string
  readonly output: unknown[]
}

export type ResponsesCompletionWriter = (response: CompletedResponsesSnapshot, inputItems: readonly unknown[]) => Promise<void>

export interface RespondResponsesOptions {
  readonly onCompleted?: ResponsesCompletionWriter
  readonly mergedInputItems?: readonly unknown[]
  readonly wantsStream: boolean
  /** Linked controller for downstream client cancel; same plumbing as messages. */
  readonly downstreamAbortController?: AbortController
  /** Optional — when provided, respond.ts persists usage + perf rows. */
  readonly telemetryCtx?: TelemetryRequestContext
  /** Optional per-request dump accumulator. */
  readonly dump?: DumpAccumulator | null
}

/**
 * Mirrors {@link ResponsesAttemptResult} from `./attempt.ts`. Declared inline
 * so this module stays decoupled from the attempt surface — the union is part
 * of the chat-flow public contract, not the leaf's implementation.
 */
export type RespondResponsesInput =
  | LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
  | { readonly kind: 'bridged-response'; readonly response: Response }

const SNAPSHOT_FAILURE = "Unable to persist response continuation state."

const reusableResponse = (body: unknown): body is CompletedResponsesSnapshot => {
  if (!body || typeof body !== "object") return false
  const response = body as Record<string, unknown>
  return typeof response.id === "string" && response.id.length > 0 && Array.isArray(response.output)
    && (response.status === "completed" || response.status === undefined)
    && !response.error && !response.incomplete_details
}

async function persistCompleted(body: unknown, options: RespondResponsesOptions): Promise<void> {
  const signal = options.downstreamAbortController?.signal
  if (signal?.aborted) throw new Error("Response cancelled.")
  if (!options.onCompleted || !reusableResponse(body)) return
  const write = options.onCompleted
  let onAbort: (() => void) | undefined
  try {
    const save = Promise.resolve().then(() => {
      if (signal?.aborted) throw new Error("Response cancelled.")
      return write(body, options.mergedInputItems ?? [])
    })
    if (signal) {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Response cancelled."))
        signal.addEventListener("abort", onAbort, { once: true })
      })
      await Promise.race([save, aborted])
    } else {
      await save
    }
  } catch {
    // Storage exceptions can contain SQL bindings, prompts, or credentials.
    throw new Error(signal?.aborted ? "Response cancelled." : SNAPSHOT_FAILURE)
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort)
  }
  if (signal?.aborted) throw new Error("Response cancelled.")
}

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
        state.rememberFailure(frame.event, 'responses')
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
    if (!state.cancelled) {
      state.failedAfter()
      dump?.failed(err)
    }
    throw err
  }
}

/**
 * Persists usage + performance rows from a drained `LlmEventResult`. Prefers
 * the interceptor-replaced `finalMetadata` over `result.modelIdentity` so
 * an interceptor that replaces the stream (the image-generation shortcut)
 * gets its own corrected identity. Otherwise the model key observed
 * in-stream supersedes the binding-time guess.
 */
async function persistFromEventResult<T>(
  result: LlmEventResult<ProtocolFrame<T>>,
  state: SourceStreamState,
  telemetryCtx: TelemetryRequestContext | undefined,
  dump?: DumpAccumulator | null,
): Promise<void> {
  if (state.persisted) return
  state.persisted = true
  telemetryCtx?.metrics?.finish(state.cancelled ? "cancelled" : state.failed ? "error" : "success")
  const md = state.cancelled
    ? { modelIdentity: { ...result.modelIdentity, ...(telemetryCtx ? { incomingModel: telemetryCtx.incomingModel } : {}) }, performance: result.performance }
    : await eventResultMetadata(result, telemetryCtx)
  const finalIdentity = result.finalMetadata && !state.cancelled
    ? md.modelIdentity
    : finalModelIdentity(md.modelIdentity, state.modelKey, result.resolveModelIdentity)
  if (dump) {
    dump.success(finalIdentity, state.usage.tokens)
    if (state.cancelled) dump.cancelled()
    else if (state.failed) dump.failed('responses stream failed')
  }
  if (telemetryCtx) {
    await recordUsage(telemetryCtx, finalIdentity, state.usage.tokens)
    await recordPerformance(
      telemetryCtx,
      md.performance,
      state.failed && !state.cancelled,
      undefined,
      performanceTargetFromTranslatorPair(finalIdentity),
      finalIdentity,
    )
  }
}

// Cross-protocol streaming: apply translator at SSE-time so the SSE encoder
// sees source-shape (responses) frames; same-protocol falls through unchanged.
//
// When `translateEvents` is set on the LlmEventResult, `result.events` carries
// HUB-shape frames (e.g. `ProtocolFrame<MessagesStreamEvent>` for
// responses→messages, or `ProtocolFrame<ChatCompletionsStreamEvent>` for
// responses→chat_completions). Before SSE encoding we:
//   1. unwrap `ProtocolFrame<HubFrame>` → bare hub events (yield `frame.event`
//      for `frame.type === 'event'`),
//   2. run them through the translator (`translateMessagesToResponsesSSE`,
//      `translateChatToResponsesSSE`),
//   3. re-wrap each yielded source event as a `ProtocolFrame<ResponsesStreamEvent>`.
// No `doneFrame()` is appended — responses SSE terminates with
// `response.completed`/`incomplete`/`failed` (natural terminators from the
// translator), not a synthetic sentinel.
async function* applyTranslatorEventsForStreaming(
  hubFrames: AsyncIterable<ProtocolFrame<unknown>>,
  translateEvents: NonNullable<LlmEventResult<unknown>['translateEvents']>,
  signal: AbortSignal | undefined,
  model: string | undefined,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  for await (const event of translateStream(hubFrames, translateEvents, signal, model)) yield eventFrame(event as ResponsesStreamEvent)
}

/**
 * Mid-stream errors must still terminate with a well-formed SSE record so
 * the client parser doesn't hang waiting for the next chunk. Responses'
 * `error` event shape is `{type: 'error', message, ...}` with the SSE
 * `event: error` name.
 */
const renderEventsAsSSE = (
  result: LlmEventResult<ProtocolFrame<ResponsesStreamEvent>>,
  options: RespondResponsesOptions,
): Response => {
  const state = new SourceStreamState(result.modelIdentity.modelKey, result.modelIdentity.model)
  const onClientAbort = (): void => {
    if (state.cancelled) return
    state.cancelled = true
    options.dump?.cancelled()
    options.telemetryCtx?.metrics?.finish("cancelled")
    if (options.telemetryCtx || options.dump) waitUntil(persistFromEventResult(result, state, options.telemetryCtx, options.dump))
  }
  options.downstreamAbortController?.signal.addEventListener("abort", onClientAbort, { once: true })
  if (options.downstreamAbortController?.signal.aborted) onClientAbort()
  // Cross-protocol streaming: apply translator at SSE-time so the SSE encoder
  // sees source-shape frames; same-protocol falls through unchanged.
  const upstreamFrames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = result.translateEvents
    ? applyTranslatorEventsForStreaming(
        result.events as unknown as AsyncIterable<ProtocolFrame<unknown>>,
        result.translateEvents,
        options.downstreamAbortController?.signal,
        result.modelIdentity.model,
      )
    : result.events
  const events = consumeWithState(upstreamFrames, state, options.dump)
  const output = new ResponsesFinalOutput()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const keepalive = startSseKeepalive(controller, COMMENT_KEEPALIVE_FRAME)
      try {
        for await (const frame of events) {
          if (cancelled || state.cancelled) break
          const canonical = frame.type === "event" ? { ...frame, event: output.observe(frame.event) } : frame
          if (canonical.type === "event" && canonical.event.type === "response.completed") {
            await persistCompleted(canonical.event.response, options)
          }
          if (cancelled || state.cancelled) break
          const sse = responsesProtocolFrameToSSEFrame(canonical)
          if (sse !== null && !cancelled) {
            if (frame.type === "event") options.telemetryCtx?.metrics?.observeOutput("responses", frame.event)
            if (!cancelled) controller.enqueue(encodeSseFrame(sse))
          }
          keepalive.touch()
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!state.cancelled) {
          state.failedAfter()
          options.dump?.failed(message)
        }
        if (!cancelled && !state.cancelled) controller.enqueue(
          encodeSseFrame(
            sseFrame(JSON.stringify({ type: 'error', message }), 'error'),
          ),
        )
      } finally {
        keepalive.stop()
        options.downstreamAbortController?.signal.removeEventListener("abort", onClientAbort)
        if (!cancelled) controller.close()
        if (options.telemetryCtx || options.dump) {
          waitUntil(persistFromEventResult(result, state, options.telemetryCtx, options.dump))
        }
      }
    },
    cancel(_reason) {
      cancelled = true
      onClientAbort()
      options.downstreamAbortController?.abort()
    },
  })
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      ...(options.telemetryCtx?.metrics?.synthetic ? { "x-gateway-stream-timing": "unavailable" } : {}),
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
 *
 * Cross-protocol attempts (Spec 6 Part 3): when `translatorPair` is present,
 * the events array carries HUB-shaped frames. Reassemble using the hub's
 * reassembler, then hand the hub-shaped JSON to `translateBody` to convert
 * back to the responses JSON envelope before responding. Same-protocol attempts
 * leave `translatorPair`/`translateBody` undefined and use the responses reassembler.
 */
const renderEventsAsJson = async (
  result: LlmEventResult<ProtocolFrame<ResponsesStreamEvent>>,
  options: RespondResponsesOptions,
): Promise<Response> => {
  const state = new SourceStreamState(result.modelIdentity.modelKey, result.modelIdentity.model)
  const onClientAbort = (): void => {
    if (state.cancelled) return
    state.cancelled = true
    options.dump?.cancelled()
    options.telemetryCtx?.metrics?.finish("cancelled")
    if (options.telemetryCtx || options.dump) waitUntil(persistFromEventResult(result, state, options.telemetryCtx, options.dump))
  }
  options.downstreamAbortController?.signal.addEventListener("abort", onClientAbort, { once: true })
  if (options.downstreamAbortController?.signal.aborted) onClientAbort()
  const events = consumeWithState(result.events, state, options.dump)
  try {
    // Dispatch reassembly on hub protocol — same-protocol (or absent) →
    // responses reassembler; cross-protocol → hub reassembler so the
    // hub-shaped frames reassemble into a hub-shaped envelope first.
    const hub = result.modelIdentity.translatorPair?.hub
    let reassembled: unknown
    if (hub === 'chat_completions') {
      reassembled = await collectChatCompletionsProtocolEventsToResult(events as never)
    } else if (hub === 'messages') {
      reassembled = await collectMessagesProtocolEventsToResult(events as never)
    } else {
      reassembled = await collectResponsesProtocolEventsToResult(events as never)
    }
    // If a translator-supplied body translator is attached, convert the
    // hub-shaped JSON back to the source (responses) JSON envelope.
    const finalBody = result.translateBody
      ? await result.translateBody(reassembled, {
          signal: options.downstreamAbortController?.signal ?? new AbortController().signal,
          model: state.publicModel,
        })
      : reassembled
    await persistCompleted(finalBody, options)
    if (options.telemetryCtx || options.dump) {
      waitUntil(persistFromEventResult(result, state, options.telemetryCtx, options.dump))
    }
    return Response.json(finalBody)
  } catch (err) {
    if (!state.cancelled) state.failedAfter()
    if (options.telemetryCtx || options.dump) {
      waitUntil(persistFromEventResult(result, state, options.telemetryCtx, options.dump))
    }
    const message = err instanceof Error ? err.message : String(err)
    if (!state.cancelled) options.dump?.failed(message)
    return Response.json(
      { error: { type: 'api_error', message } },
      { status: 502 },
    )
  } finally {
    options.downstreamAbortController?.signal.removeEventListener("abort", onClientAbort)
  }
}

const isBridgedResponse = (
  result: RespondResponsesInput,
): result is { readonly kind: 'bridged-response'; readonly response: Response } =>
  'kind' in result && result.kind === 'bridged-response'

/**
 * Repackage an upstream non-2xx body as a Responses-shaped error envelope.
 * Forwarded verbatim by `forwardUpstreamError(res, 'responses')` — the upstream
 * already speaks this envelope, so re-minting it could only drop fields. The
 * performance row is fired-and-forgotten via `waitUntil` so a slow repo write
 * never blocks the client response.
 */
const renderUpstreamError = async (
  result: UpstreamErrorResult,
  options: RespondResponsesOptions,
): Promise<Response> => {
  if (options.telemetryCtx) {
    waitUntil(recordPerformance(options.telemetryCtx, result.performance, true, undefined, result.targetApi))
  }
  options.dump?.error('upstream', result.performance?.upstream ?? undefined)
  return await forwardUpstreamError(upstreamErrorToResponse(result), 'responses')
}

const renderExecuteResult = async (
  result: LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>,
  options: RespondResponsesOptions,
): Promise<Response> => {
  if (result.type === 'upstream-error') return await renderUpstreamError(result, options)
  if (result.type === 'internal-error') {
    if (options.telemetryCtx) {
      // recordPerformance no-ops when `result.performance` is undefined
      // (pre-binding errors per spec §6.2 deliberately omit perf rows).
      waitUntil(recordPerformance(options.telemetryCtx, result.performance, true))
    }
    options.dump?.failed(result.error.message)
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

/** Legacy dispatch responses already own their model identity and telemetry.
 * Gate their actual wire in one pass instead of cloning or draining a sidecar. */
const renderBridgedResponse = async (response: Response, options: RespondResponsesOptions): Promise<Response> => {
  if (!options.onCompleted || !response.ok) return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const contentType = headers.get("content-type") ?? ""
  if (contentType.includes("application/json")) {
    try {
      const body: unknown = await response.json()
      await persistCompleted(body, options)
      return Response.json(body, { status: response.status, headers })
    } catch {
      return Response.json({ error: { type: "api_error", message: SNAPSHOT_FAILURE } }, { status: 502 })
    }
  }
  if (!contentType.includes("text/event-stream") || !response.body) {
    void response.body?.cancel().catch(() => {})
    return Response.json({ error: { type: "api_error", message: "Unsupported response format for continuation storage." } }, { status: 502 })
  }
  const abort = options.downstreamAbortController ?? new AbortController()
  const body = response.body
  let cancelled = false
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      const output = new ResponsesFinalOutput()
      const keepalive = startSseKeepalive(controller, COMMENT_KEEPALIVE_FRAME)
      try {
        for await (const frame of parseSSEStream(body, { signal: abort.signal })) {
          if (abort.signal.aborted) break
          if (frame.data === "[DONE]") continue
          const parsed = JSON.parse(frame.data) as Record<string, unknown>
          const event = output.observe((frame.event && !parsed.type ? { ...parsed, type: frame.event } : parsed) as unknown as ResponsesStreamEvent)
          if (event.type === "response.completed") await persistCompleted(event.response, { ...options, downstreamAbortController: abort })
          if (abort.signal.aborted) break
          controller.enqueue(encodeSseFrame(sseFrame(JSON.stringify(event), frame.event ?? event.type)))
          keepalive.touch()
        }
      } catch {
        if (!abort.signal.aborted) controller.enqueue(encodeSseFrame(sseFrame(JSON.stringify({ type: "error", message: SNAPSHOT_FAILURE }), "error")))
      } finally {
        keepalive.stop()
        if (!cancelled) controller.close()
      }
    },
    cancel() { cancelled = true; abort.abort() },
  }), { status: response.status, headers })
}

export const respondResponses = async (
  result: RespondResponsesInput,
  options: RespondResponsesOptions,
): Promise<Response> => {
  // bridged-response is the legacy `dispatch()` short-circuit from
  // attempt.ts; the wrapped Response is already client-shaped.
  if (isBridgedResponse(result)) return await renderBridgedResponse(result.response, options)
  return await renderExecuteResult(result, options)
}
