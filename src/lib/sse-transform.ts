/**
 * Create a line-based SSE TransformStream that re-emits selected `data:` payloads.
 *
 * This is the lightweight variant — it does not care about `event:` lines,
 * concatenated multi-line data, or frame terminators. It simply scans for
 * `data: ...` lines and lets the caller decide what bytes to enqueue.
 *
 * For frame-aware parsing (events, ids, retry) use createFrameBuffer from
 * ./sse/parser instead.
 *
 * @param onLine Called for each complete `data:` line value (after trim, DONE excluded).
 *               Should return encoded bytes to enqueue, or null to skip.
 * @param doneMarker The SSE stream termination marker (default "[DONE]").
 */
export function createSSETransform(
  onLine: (data: string) => Uint8Array | null,
  doneMarker = "[DONE]",
): TransformStream<Uint8Array, Uint8Array> {
  let buffer = ""
  const decoder = new TextDecoder()

  const processLine = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!line.startsWith("data: ")) return
    const data = line.slice(6).trim()
    if (!data || data === doneMarker) return
    const result = onLine(data)
    if (result) controller.enqueue(result)
  }

  return new TransformStream({
    transform(chunk: Uint8Array, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const parts = buffer.split("\n")
      buffer = parts.pop() ?? ""
      for (const line of parts) processLine(line, controller)
    },
    flush(controller) {
      if (buffer.trim()) processLine(buffer.trim(), controller)
    },
  })
}
