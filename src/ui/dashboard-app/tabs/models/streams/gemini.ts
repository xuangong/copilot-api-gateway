import type { StreamChunk, StreamUsage } from "./openai"

export type { StreamChunk, StreamUsage }

// Gemini SSE format (?alt=sse): each event is `data: {json}\n\n`.
// Each chunk carries candidates[0].content.parts[*].text (incremental) and
// optionally a usageMetadata block. The final chunk includes finishReason and
// the cumulative usageMetadata.
export async function* parseGeminiStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let lastUsage: StreamUsage | null = null
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) !== -1) {
        const raw = buf.slice(0, nl).replace(/\r$/, "")
        buf = buf.slice(nl + 1)
        const out = parseLine(raw)
        if (out) {
          if (out.type === "delta") yield out
          else lastUsage = out.usage
        }
      }
    }
    const tail = buf.replace(/\r$/, "")
    const out = parseLine(tail)
    if (out) {
      if (out.type === "delta") yield out
      else lastUsage = out.usage
    }
  } finally {
    reader.releaseLock()
  }
  if (lastUsage) yield { type: "usage", usage: lastUsage }
}

function parseLine(raw: string): StreamChunk | null {
  if (!raw.startsWith("data:")) return null
  const payload = raw.slice(5).trim()
  if (!payload) return null
  let json: unknown
  try {
    json = JSON.parse(payload)
  } catch {
    return null
  }
  const obj = json as {
    error?: { message?: string }
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> }
    }>
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
    }
  }
  if (obj.error) throw new Error(obj.error.message ?? "Gemini stream error")
  const parts = obj.candidates?.[0]?.content?.parts
  let text = ""
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (typeof p?.text === "string") text += p.text
    }
  }
  if (text) return { type: "delta", text }
  if (obj.usageMetadata) {
    return {
      type: "usage",
      usage: {
        input_tokens: obj.usageMetadata.promptTokenCount ?? 0,
        output_tokens: obj.usageMetadata.candidatesTokenCount ?? 0,
      },
    }
  }
  return null
}
