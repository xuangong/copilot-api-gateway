export async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let currentEvent = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) !== -1) {
        const raw = buf.slice(0, nl).replace(/\r$/, "")
        buf = buf.slice(nl + 1)
        if (raw === "") {
          currentEvent = ""
          continue
        }
        if (raw.startsWith("event:")) {
          currentEvent = raw.slice(6).trim()
          continue
        }
        if (!raw.startsWith("data:")) continue
        const payload = raw.slice(5).trim()
        if (!payload) continue
        let json: unknown
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        const obj = json as {
          type?: string
          delta?: { type?: string; text?: string }
          error?: { message?: string }
        }
        if (currentEvent === "error" || obj.type === "error") {
          throw new Error(obj.error?.message ?? "Anthropic stream error")
        }
        if (currentEvent === "message_stop" || obj.type === "message_stop") {
          return
        }
        if (
          (currentEvent === "content_block_delta" || obj.type === "content_block_delta") &&
          obj.delta?.type === "text_delta" &&
          typeof obj.delta.text === "string"
        ) {
          yield obj.delta.text
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
