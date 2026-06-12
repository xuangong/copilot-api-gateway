/**
 * Per-source SSE wire encoders for the pairwise dispatch pipeline.
 *
 * The translator's `translateEvents` produces typed objects already in the
 * client wire shape (Anthropic Messages events, Chat Completions chunks,
 * Responses events, Gemini stream responses). All that's left is to encode
 * each event as the SSE bytes the client expects.
 *
 * Encoder rules per source:
 *
 *  - messages   : `event: <event.type>\ndata: {...}\n\n`  (Anthropic Messages SSE)
 *                 No trailing [DONE] frame; the `message_stop` event is the
 *                 terminator by convention.
 *  - chat       : `data: {...}\n\n` … `data: [DONE]\n\n`  (OpenAI Chat SSE)
 *  - responses  : `event: <event.type>\ndata: {...}\n\n`  (OpenAI Responses SSE)
 *                 No trailing [DONE] — Responses stream uses `response.completed`
 *                 as terminator.
 *  - gemini     : `data: {...}\n\n`  (Gemini streamGenerateContent style)
 *                 No event-name prefix, no [DONE] terminator.
 *
 * Errors thrown by the translator (validation, abort) are encoded as the same
 * shape the corresponding frontend adapter used previously, so downstream SDKs
 * see error frames in their native wire format.
 */
import type { SourceApi } from './pair-selector.ts'

const ENC = new TextEncoder()

function sseEvent(name: string | null, data: unknown): string {
  const json = typeof data === 'string' ? data : JSON.stringify(data)
  return (name ? `event: ${name}\n` : '') + `data: ${json}\n\n`
}

/** Render a hub→client error in the source-specific wire shape. */
function errorFrame(source: SourceApi, message: string): string {
  if (source === 'messages') {
    return sseEvent('error', { type: 'error', error: { type: 'api_error', message } })
  }
  if (source === 'chat_completions') {
    return sseEvent(null, { error: { message, type: 'api_error' } })
  }
  if (source === 'responses') {
    return sseEvent('error', { type: 'error', error: { type: 'api_error', message } })
  }
  // gemini: no canonical error frame; mirror the data-only stream convention.
  return sseEvent(null, { error: { message } })
}

/**
 * Encode an `AsyncIterable` of already-client-shaped events into a
 * `ReadableStream<Uint8Array>` according to the source's SSE convention.
 */
export function encodeClientSSE(
  source: SourceApi,
  events: AsyncIterable<unknown>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const evt of events) {
          if (source === 'messages' || source === 'responses') {
            const name = (evt as { type?: string } | null)?.type
            controller.enqueue(ENC.encode(sseEvent(name ?? null, evt)))
          } else {
            // chat_completions / gemini: data-only
            controller.enqueue(ENC.encode(sseEvent(null, evt)))
          }
        }
        if (source === 'chat_completions') {
          controller.enqueue(ENC.encode('data: [DONE]\n\n'))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        controller.enqueue(ENC.encode(errorFrame(source, msg)))
      } finally {
        controller.close()
      }
    },
  })
}
