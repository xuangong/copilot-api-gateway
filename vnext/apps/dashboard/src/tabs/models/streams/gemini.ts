import { toCitations, type StreamChunk, type StreamUsage } from "./openai"

export type { StreamChunk, StreamUsage }

// Gemini SSE format (?alt=sse): each event is `data: {json}\n\n`.
// Each chunk carries candidates[0].content.parts[*].text (incremental) and
// optionally a usageMetadata block. The final chunk includes finishReason,
// groundingMetadata (when the turn was web-grounded) and the cumulative
// usageMetadata — so a single line can produce several chunks.
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
        for (const out of parseLine(raw)) {
          if (out.type === "usage") lastUsage = out.usage
          else yield out
        }
      }
    }
    const tail = buf.replace(/\r$/, "")
    for (const out of parseLine(tail)) {
      if (out.type === "usage") lastUsage = out.usage
      else yield out
    }
  } finally {
    reader.releaseLock()
  }
  if (lastUsage) yield { type: "usage", usage: lastUsage }
}

function parseLine(raw: string): StreamChunk[] {
  if (!raw.startsWith("data:")) return []
  const payload = raw.slice(5).trim()
  if (!payload) return []
  let json: unknown
  try {
    json = JSON.parse(payload)
  } catch {
    return []
  }
  const obj = json as {
    error?: { message?: string }
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> }
      groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> }
    }>
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
    }
  }
  if (obj.error) throw new Error(obj.error.message ?? "Gemini stream error")

  const out: StreamChunk[] = []

  const parts = obj.candidates?.[0]?.content?.parts
  let text = ""
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (typeof p?.text === "string") text += p.text
    }
  }
  if (text) out.push({ type: "delta", text })

  // Grounding rides on the final candidate, alongside finishReason and usage.
  const grounding = obj.candidates?.[0]?.groundingMetadata?.groundingChunks
  if (Array.isArray(grounding)) {
    const citations = toCitations(
      grounding.flatMap((chunk) => (chunk.web?.uri ? [{ url: chunk.web.uri, title: chunk.web.title }] : [])),
    )
    if (citations.length) out.push({ type: "citations", citations })
  }

  if (obj.usageMetadata) {
    out.push({
      type: "usage",
      usage: {
        input_tokens: obj.usageMetadata.promptTokenCount ?? 0,
        output_tokens: obj.usageMetadata.candidatesTokenCount ?? 0,
      },
    })
  }
  return out
}
