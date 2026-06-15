// vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts
/**
 * Chat Completions response renderer.
 *
 * Converts the {@link ChatCompletionsAttemptResult} (events / upstream-error /
 * internal-error from `ExecuteResult` plus the bridged-response sentinel) into
 * a single `Response` for the client. SSE streaming is rendered frame-by-frame
 * via {@link chatCompletionsProtocolFrameToSSEFrame}; non-streaming requests
 * drain to a reassembled JSON envelope. The bridged-response branch hands the
 * legacy `dispatch()` `Response` back unchanged.
 *
 * Reference: copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/respond.ts
 */
import {
  upstreamErrorToResponse,
  sseFrame,
  type ExecuteResult,
  type ProtocolFrame,
  type SseFrame,
  type UpstreamErrorResult,
} from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'
import { repackageUpstreamError } from '../../errors/repackage'
import { collectChatCompletionsProtocolEventsToResult } from './events/to-result'
import { chatCompletionsProtocolFrameToSSEFrame } from './events/to-sse'

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
}

/**
 * Mirrors {@link ChatCompletionsAttemptResult} from `./attempt.ts`. Declared
 * inline rather than imported to keep this module decoupled from the attempt
 * surface — the union is part of the chat-flow public contract, not the
 * leaf's implementation.
 */
export type RespondChatCompletionsInput =
  | ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>
  | { readonly kind: 'bridged-response'; readonly response: Response }

const SSE_TEXT_ENCODER = new TextEncoder()

// Serialises an `SseFrame` to wire bytes. Matches the legacy shape (`event: …`
// then `data: …`, terminated by a blank line) so SDK parsers stay happy.
const encodeSseFrame = (frame: SseFrame): Uint8Array => {
  const lines: string[] = []
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`)
  lines.push(`data: ${frame.data}`)
  return SSE_TEXT_ENCODER.encode(lines.join('\n') + '\n\n')
}

// Mid-stream errors must still terminate with a well-formed SSE record so the
// client parser doesn't hang waiting for the next chunk. We emit a single
// `event: error` frame carrying a minimal `{ error: { message } }` payload
// before closing the controller.
const renderEventsAsSSE = (
  events: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
  options: RespondChatCompletionsOptions,
): Response => {
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
// internal-error branch.
const renderEventsAsJson = async (
  events: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
): Promise<Response> => {
  try {
    const result = await collectChatCompletionsProtocolEventsToResult(events)
    return Response.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: { message } }, { status: 502 })
  }
}

// The bridged-response sentinel uses `kind` while ExecuteResult uses `type`,
// so the union's discriminants are disjoint. TS can't narrow the negation of
// `'kind' in x && x.kind === 'bridged-response'` to "this is an ExecuteResult"
// because Object types don't preclude having a `kind` property. We narrow with
// an explicit guard + dedicated executeResult dispatcher.
const isBridgedResponse = (
  result: RespondChatCompletionsInput,
): result is { readonly kind: 'bridged-response'; readonly response: Response } =>
  'kind' in result && result.kind === 'bridged-response'

// Upstream errors carry the raw provider body verbatim; the OpenAI SDK expects
// the `{ error: { type, message, ...code } }` envelope shape. We reuse the
// existing `repackageUpstreamError` helper (sourceApi='chat_completions') so
// the body is normalized identically to the legacy `dispatch()` path — same
// type defaults (`invalid_request_error` for 4xx, `api_error` for 5xx), same
// status preservation.
const renderUpstreamError = async (result: UpstreamErrorResult): Promise<Response> =>
  await repackageUpstreamError(upstreamErrorToResponse(result), 'chat_completions')

const renderExecuteResult = async (
  result: ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>,
  options: RespondChatCompletionsOptions,
): Promise<Response> => {
  if (result.type === 'upstream-error') return await renderUpstreamError(result)
  if (result.type === 'internal-error') {
    return Response.json({ error: { message: result.error.message } }, { status: result.status })
  }
  // result.type === 'events'
  return options.wantsStream
    ? renderEventsAsSSE(result.events, options)
    : await renderEventsAsJson(result.events)
}

export const respondChatCompletions = async (
  result: RespondChatCompletionsInput,
  options: RespondChatCompletionsOptions,
): Promise<Response> => {
  // bridged-response is the legacy `dispatch()` short-circuit from
  // attempt.ts; the wrapped Response is already client-shaped.
  if (isBridgedResponse(result)) return result.response
  return await renderExecuteResult(result, options)
}
