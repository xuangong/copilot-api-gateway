// vnext/packages/gateway/src/data-plane/chat-flow/gemini/respond.ts
/**
 * Gemini response renderer.
 *
 * Converts the {@link GeminiAttemptResult} (events / upstream-error /
 * internal-error from `ExecuteResult`) into a single `Response` for the
 * client. Two render branches:
 *
 *   - `wantsStream === true` (URL verb was `streamGenerateContent`): SSE
 *     rendering via `encodeClientSSE('gemini', …)`. Data-only frames
 *     (`data: <json>\n\n`), no event name, no `[DONE]` terminator — gemini
 *     convention.
 *
 *   - `wantsStream === false` (URL verb was `generateContent`): the upstream
 *     still streams (attempt.ts always parses an SSE body), but we drain the
 *     events into a single `GeminiResult` JSON envelope before responding.
 *     This is the "buffered" path that legacy `dispatch()` handled via
 *     `translator.translateBody(attempt.json, ctx)`. Here the translator
 *     already produced bare gemini stream events, so we reassemble them
 *     into the non-streaming response shape directly.
 *
 * Both branches funnel through `consumeWithState` for telemetry observation
 * (model-key correction + usage capture + mid-stream-fail flag), then
 * `waitUntil(persistFromEventResult(...))` after the stream settles. This
 * mirrors the messages/responses respond modules.
 *
 * Unlike messages, gemini has no `bridged-response` sentinel — there's no
 * gemini-shape hub target, so every successful binding selection drives
 * the events path.
 *
 * Reference: messages/respond.ts, chat-completions/respond.ts.
 */
import { waitUntil } from '@vnext/platform'
import {
  upstreamErrorToResponse,
  type EventResult,
  type ExecuteResult,
  type UpstreamErrorResult,
} from '@vnext/protocols/common'
import { repackageUpstreamError } from '../../errors/repackage'
import { encodeClientSSE } from '../../dispatch/sse-writers.ts'
import { SourceStreamState, recordPerformance } from '../shared/respond-telemetry.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { consumeWithState, persistFromEventResult } from './state-bridge.ts'

export interface RespondGeminiOptions {
  /**
   * True when the URL verb was `streamGenerateContent` (client wants SSE).
   * False when it was `generateContent` (client wants a single JSON envelope).
   * NOTE: The upstream always streams (attempt.ts parses the body as SSE);
   * this flag decides only how WE present the result to the client.
   */
  readonly wantsStream: boolean
  /**
   * Optional abort signal used to cancel an in-flight SSE source generator
   * when the downstream client disconnects mid-stream. Same plumbing as the
   * messages renderer.
   */
  readonly downstreamAbortController?: AbortController
  /**
   * Optional — when provided, respond.ts persists usage + performance rows
   * via `recordUsage` + `recordPerformance` (wrapped in `waitUntil`). Unit
   * tests omit this to skip persistence.
   */
  readonly telemetryCtx?: TelemetryRequestContext
}

/**
 * SSE rendering branch. Data-only frames per gemini convention. Telemetry
 * observation happens inline via `consumeWithState`; on stream close we
 * `waitUntil` the persistence helper so the client response isn't blocked.
 *
 * `encodeClientSSE('gemini', …)` already handles the data-only frame shape
 * (no `event:` prefix, no `[DONE]`) and emits an `{error: {message}}` frame
 * on translator throws — matching the legacy dispatch behaviour. We wrap
 * that ReadableStream in an outer stream so we can hook the `cancel` for
 * downstream-abort propagation and run telemetry persistence on close.
 */
const renderEventsAsSSE = (
  result: EventResult<unknown>,
  options: RespondGeminiOptions,
): Response => {
  const state = options.telemetryCtx
    ? new SourceStreamState(result.modelIdentity.modelKey)
    : null
  const events = state ? consumeWithState(result.events, state) : result.events
  const inner = encodeClientSSE('gemini', events)
  const reader = inner.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read()
      if (done) {
        controller.close()
        if (state && options.telemetryCtx) {
          waitUntil(persistFromEventResult(result, state, options.telemetryCtx))
        }
        return
      }
      controller.enqueue(value)
    },
    async cancel(_reason) {
      try { await reader.cancel() } catch { /* swallow */ }
      options.downstreamAbortController?.abort()
      if (state && options.telemetryCtx) {
        waitUntil(persistFromEventResult(result, state, options.telemetryCtx))
      }
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
 * Shape of a gemini stream frame for the reassembly accumulator. Each frame
 * is a partial `GeminiResult`: candidates carry incremental text parts (and
 * the terminal `finishReason`); `usageMetadata` and `modelVersion` typically
 * arrive on the final frame; `responseId` is set on every frame but stable.
 */
interface GeminiFrameShape {
  candidates?: ReadonlyArray<{
    index?: number
    content?: { role?: string; parts?: ReadonlyArray<{ text?: string; thought?: boolean; [k: string]: unknown }> }
    finishReason?: string
    [k: string]: unknown
  }>
  usageMetadata?: Record<string, unknown>
  modelVersion?: string
  model?: string
  responseId?: string
  [k: string]: unknown
}

interface GeminiErrorFrameShape {
  error: { code?: number; message?: string; status?: string; [k: string]: unknown }
}

/**
 * Non-stream reassembly: drain the gemini stream events into a single
 * `GeminiResult`-shaped JSON envelope. Strategy:
 *
 *   - Group candidates by `index` (default 0); concatenate text parts; keep
 *     the most recently seen `finishReason`; copy non-text parts (functionCall
 *     etc.) verbatim from whichever frame produced them.
 *   - Top-level fields (`usageMetadata`, `modelVersion`, `responseId`):
 *     last-wins, since gemini emits them mostly on the terminal frame.
 *   - Error frame (`{error: {…}}`) short-circuits — return the error envelope
 *     as the response body, with the upstream status code reflected via 502
 *     (we don't have a wire-shape way to surface the original status here;
 *     the legacy dispatch path also collapsed mid-stream errors this way).
 */
const reassembleGeminiEvents = async (
  events: AsyncIterable<unknown>,
): Promise<Record<string, unknown>> => {
  type CandAcc = {
    index: number
    role?: string
    textChunks: string[]
    extraParts: Array<Record<string, unknown>>
    finishReason?: string
    extra: Record<string, unknown>
  }
  const cands = new Map<number, CandAcc>()
  let usageMetadata: Record<string, unknown> | undefined
  let modelVersion: string | undefined
  let responseId: string | undefined
  let errorFrame: GeminiErrorFrameShape | null = null

  for await (const raw of events) {
    const frame = raw as GeminiFrameShape | GeminiErrorFrameShape | null
    if (!frame || typeof frame !== 'object') continue
    if ('error' in frame && frame.error && typeof frame.error === 'object') {
      errorFrame = frame as GeminiErrorFrameShape
      continue
    }
    const f = frame as GeminiFrameShape
    if (Array.isArray(f.candidates)) {
      for (const cand of f.candidates) {
        const idx = typeof cand.index === 'number' ? cand.index : 0
        let acc = cands.get(idx)
        if (!acc) {
          acc = { index: idx, textChunks: [], extraParts: [], extra: {} }
          cands.set(idx, acc)
        }
        if (cand.content?.role && !acc.role) acc.role = cand.content.role
        if (Array.isArray(cand.content?.parts)) {
          for (const part of cand.content.parts) {
            if (typeof part.text === 'string' && !part.thought) {
              acc.textChunks.push(part.text)
            } else if (typeof part.text !== 'string' || part.thought) {
              // Non-text part (functionCall, inlineData, thought, …) — keep
              // verbatim. Thoughts are preserved as-is so callers can see
              // model reasoning frames.
              acc.extraParts.push({ ...(part as Record<string, unknown>) })
            }
          }
        }
        if (cand.finishReason) acc.finishReason = cand.finishReason
        for (const [k, v] of Object.entries(cand)) {
          if (k === 'index' || k === 'content' || k === 'finishReason') continue
          acc.extra[k] = v
        }
      }
    }
    if (f.usageMetadata) usageMetadata = f.usageMetadata
    if (typeof f.modelVersion === 'string') modelVersion = f.modelVersion
    else if (typeof f.model === 'string') modelVersion = f.model
    if (typeof f.responseId === 'string') responseId = f.responseId
  }

  if (errorFrame) {
    // Error frame short-circuits — return the gemini-shape error envelope.
    return errorFrame as unknown as Record<string, unknown>
  }

  const candidates = [...cands.values()]
    .sort((a, b) => a.index - b.index)
    .map(acc => {
      const parts: Array<Record<string, unknown>> = []
      if (acc.textChunks.length > 0) parts.push({ text: acc.textChunks.join('') })
      for (const p of acc.extraParts) parts.push(p)
      const out: Record<string, unknown> = {
        index: acc.index,
        content: { role: acc.role ?? 'model', parts },
        ...acc.extra,
      }
      if (acc.finishReason) out.finishReason = acc.finishReason
      return out
    })

  const envelope: Record<string, unknown> = { candidates }
  if (usageMetadata) envelope.usageMetadata = usageMetadata
  if (modelVersion) envelope.modelVersion = modelVersion
  if (responseId) envelope.responseId = responseId
  return envelope
}

/**
 * Non-streaming branch. Drains the stream into a single `GeminiResult`
 * envelope and emits it as JSON. Any reassembly error surfaces as a 502 with
 * the gemini-shape `{error: {message}}` envelope. Telemetry persistence runs
 * in both success and error paths.
 */
const renderEventsAsJson = async (
  result: EventResult<unknown>,
  options: RespondGeminiOptions,
): Promise<Response> => {
  const state = options.telemetryCtx
    ? new SourceStreamState(result.modelIdentity.modelKey)
    : null
  const events = state ? consumeWithState(result.events, state) : result.events
  try {
    const envelope = await reassembleGeminiEvents(events)
    if (state && options.telemetryCtx) {
      waitUntil(persistFromEventResult(result, state, options.telemetryCtx))
    }
    return Response.json(envelope)
  } catch (err) {
    if (state) state.failedAfter()
    if (state && options.telemetryCtx) {
      waitUntil(persistFromEventResult(result, state, options.telemetryCtx))
    }
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: { message } }, { status: 502 })
  }
}

/**
 * Repackage an upstream non-2xx body as a gemini-shape error envelope.
 * Reuses `repackageUpstreamError(res, 'gemini')` for parity with the legacy
 * `dispatch()` path. The performance row is fired-and-forgotten via
 * `waitUntil`.
 */
const renderUpstreamError = async (
  result: UpstreamErrorResult,
  options: RespondGeminiOptions,
): Promise<Response> => {
  if (options.telemetryCtx) {
    waitUntil(recordPerformance(options.telemetryCtx, result.performance, true))
  }
  return await repackageUpstreamError(upstreamErrorToResponse(result), 'gemini')
}

const renderExecuteResult = async (
  result: ExecuteResult<unknown>,
  options: RespondGeminiOptions,
): Promise<Response> => {
  if (result.type === 'upstream-error') return await renderUpstreamError(result, options)
  if (result.type === 'internal-error') {
    if (options.telemetryCtx) {
      // recordPerformance no-ops when `result.performance` is undefined
      // (pre-binding errors per spec §6.2 deliberately omit perf rows).
      waitUntil(recordPerformance(options.telemetryCtx, result.performance, true))
    }
    return Response.json(
      { error: { message: result.error.message } },
      { status: result.status },
    )
  }
  // result.type === 'events'
  return options.wantsStream
    ? renderEventsAsSSE(result, options)
    : await renderEventsAsJson(result, options)
}

export const respondGemini = async (
  result: ExecuteResult<unknown>,
  options: RespondGeminiOptions,
): Promise<Response> => {
  return await renderExecuteResult(result, options)
}
