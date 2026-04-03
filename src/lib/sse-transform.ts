/**
 * Create an SSE line-buffered TransformStream.
 *
 * Upstream SSE data may arrive split across TCP segments.
 * This transform buffers partial lines and emits complete lines only.
 *
 * @param onLine Called for each complete `data: ...` line (excluding the DONE marker).
 *               Should return encoded bytes to enqueue, or null to skip.
 * @param doneMarker The SSE stream termination marker (default "[DONE]").
 */
export function createSSETransform(
  onLine: (data: string) => Uint8Array | null,
  doneMarker = "[DONE]",
): TransformStream<Uint8Array, Uint8Array> {
  let buffer = ""

  return new TransformStream({
    transform(chunk: Uint8Array, controller) {
      buffer += new TextDecoder().decode(chunk)
      const parts = buffer.split("\n")
      // Last element is incomplete — keep it in the buffer
      buffer = parts.pop() ?? ""

      for (const line of parts) {
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6).trim()
        if (data === doneMarker || !data) continue

        const result = onLine(data)
        if (result) {
          controller.enqueue(result)
        }
      }
    },
    flush(controller) {
      // Process any remaining buffered data
      if (buffer.trim()) {
        const line = buffer.trim()
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim()
          if (data && data !== doneMarker) {
            const result = onLine(data)
            if (result) {
              controller.enqueue(result)
            }
          }
        }
      }
    },
  })
}
