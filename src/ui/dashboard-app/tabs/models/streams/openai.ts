export interface StreamUsage {
  input_tokens: number
  output_tokens: number
}

export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: StreamUsage }

export async function* parseOpenAIStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) !== -1) {
        const raw = buf.slice(0, nl).replace(/\r$/, "")
        buf = buf.slice(nl + 1)
        const chunk = parseLine(raw)
        if (chunk === "DONE") return
        if (chunk) yield chunk
      }
    }
    const tail = buf.replace(/\r$/, "")
    const chunk = parseLine(tail)
    if (chunk && chunk !== "DONE") yield chunk
  } finally {
    reader.releaseLock()
  }
}

function parseLine(raw: string): StreamChunk | "DONE" | null {
  if (!raw.startsWith("data:")) return null
  const payload = raw.slice(5).trim()
  if (!payload) return null
  if (payload === "[DONE]") return "DONE"
  let json: unknown
  try {
    json = JSON.parse(payload)
  } catch {
    return null
  }
  const obj = json as {
    error?: { message?: string }
    choices?: Array<{ delta?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  if (obj.error) throw new Error(obj.error.message ?? "OpenAI stream error")
  if (obj.usage && (obj.usage.prompt_tokens != null || obj.usage.completion_tokens != null)) {
    return {
      type: "usage",
      usage: {
        input_tokens: obj.usage.prompt_tokens ?? 0,
        output_tokens: obj.usage.completion_tokens ?? 0,
      },
    }
  }
  const delta = obj.choices?.[0]?.delta?.content
  if (typeof delta === "string" && delta.length) return { type: "delta", text: delta }
  return null
}
