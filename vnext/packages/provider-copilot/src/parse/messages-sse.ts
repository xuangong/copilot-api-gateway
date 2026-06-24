/**
 * Anthropic Messages SSE parser — yields validated MessagesEvent values.
 *
 * Used by CopilotProvider.fetch when streaming the messages endpoint. Parses
 * `data: {…}\n\n` frames, validates each via MessagesEventSchema, and skips
 * unknown shapes silently. AbortSignal is honored before each read; the
 * reader is released in a `finally` so cancellation doesn't leak the stream.
 */
import { MessagesEventSchema, type MessagesEvent } from '@vnext-llm/protocols/messages'

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncIterable<MessagesEvent> {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue
        const json = dataLine.slice(6).trim()
        if (!json || json === '[DONE]') continue
        try {
          const parsed = MessagesEventSchema.parse(JSON.parse(json))
          yield parsed
        } catch {
          // unknown event shape — drop
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}

export type { MessagesEvent }
