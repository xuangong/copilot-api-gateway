import type { StreamChunk, StreamUsage } from "./openai"

export type { StreamChunk, StreamUsage }

export async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let currentEvent = ""
  let inputTokens = 0
  let outputTokens = 0
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
          message?: { usage?: { input_tokens?: number; output_tokens?: number } }
          usage?: { input_tokens?: number; output_tokens?: number }
          item_id?: string
          status?: "in_progress" | "searching" | "completed"
          query?: string
        }
        if (currentEvent === "error" || obj.type === "error") {
          throw new Error(obj.error?.message ?? "Anthropic stream error")
        }
        if (currentEvent === "web_search_progress" || obj.type === "web_search_progress") {
          if (obj.status) {
            yield {
              type: "web_search",
              progress: {
                status: obj.status,
                ...(obj.query ? { query: obj.query } : {}),
                ...(obj.item_id ? { item_id: obj.item_id } : {}),
              },
            }
          }
          continue
        }
        // message_start carries initial input_tokens; message_delta carries final output_tokens
        const startUsage = obj.message?.usage
        if (startUsage?.input_tokens != null) inputTokens = startUsage.input_tokens
        if (startUsage?.output_tokens != null) outputTokens = startUsage.output_tokens
        if (obj.usage?.input_tokens != null) inputTokens = obj.usage.input_tokens
        if (obj.usage?.output_tokens != null) outputTokens = obj.usage.output_tokens
        if (currentEvent === "message_stop" || obj.type === "message_stop") {
          if (inputTokens || outputTokens) {
            yield { type: "usage", usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
          }
          return
        }
        if (
          (currentEvent === "content_block_delta" || obj.type === "content_block_delta") &&
          obj.delta?.type === "text_delta" &&
          typeof obj.delta.text === "string"
        ) {
          yield { type: "delta", text: obj.delta.text }
        }
      }
    }
    if (inputTokens || outputTokens) {
      yield { type: "usage", usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
    }
  } finally {
    reader.releaseLock()
  }
}
