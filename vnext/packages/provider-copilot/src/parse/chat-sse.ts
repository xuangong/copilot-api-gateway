/**
 * OpenAI Chat Completions SSE parser — yields raw `data:` JSON payloads.
 *
 * No schema validation: chat completions stream shapes vary by upstream
 * (Copilot, Azure, third-party gateways) and the consumer (chat-cc-2-hub
 * translator) does the structural mapping itself. We only:
 *   - split on \n\n frames
 *   - extract the `data: …` line
 *   - skip `[DONE]` and empty payloads
 *   - JSON.parse and yield (silently drop on parse error)
 *
 * Same reader-release / abort-signal contract as messages-sse.
 */
export async function* parseChatSSEStream(
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
