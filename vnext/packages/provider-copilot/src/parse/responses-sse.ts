/**
 * OpenAI Responses SSE parser — yields raw `data:` JSON payloads.
 *
 * Mirrors chat-sse.ts: the Responses event vocabulary is loosely typed at
 * this layer because translators (responses-cc-2-hub, hub-2-responses-cc)
 * own the structural validation. We only frame-split and JSON-parse.
 */
export async function* parseResponsesSSEStream(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
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
          yield JSON.parse(json)
        } catch {
          // malformed frame — drop
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}
