export interface StreamUsage {
  input_tokens: number
  output_tokens: number
}

export interface WebSearchProgress {
  status: "in_progress" | "searching" | "completed"
  query?: string
  item_id?: string
}

/** One source the gateway grounded the answer in. */
export interface Citation {
  url: string
  title?: string
}

export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: StreamUsage }
  | { type: "web_search"; progress: WebSearchProgress }
  | { type: "citations"; citations: Citation[] }

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
        const parsed = parseLine(raw)
        if (parsed === "DONE") return
        yield* parsed
      }
    }
    const tail = buf.replace(/\r$/, "")
    const parsed = parseLine(tail)
    if (parsed !== "DONE") yield* parsed
  } finally {
    reader.releaseLock()
  }
}

/**
 * Shared by every protocol reader: drop entries with no usable URL, dedupe by
 * URL keeping the first title seen. Accepts either a flat `{url,title}` or the
 * Chat Completions `{url_citation:{url,title}}` envelope.
 */
export function toCitations(
  raw: Array<{ url?: string; title?: string; url_citation?: { url?: string; title?: string } }>,
): Citation[] {
  const seen = new Map<string, string | undefined>()
  for (const entry of raw) {
    const source = entry.url_citation ?? entry
    const url = source.url
    if (typeof url !== "string" || !url) continue
    if (seen.has(url)) continue
    seen.set(url, source.title)
  }
  return [...seen].map(([url, title]) => (title ? { url, title } : { url }))
}

/**
 * One SSE line can carry several things at once — native OpenAI web search
 * attaches `annotations` to the same delta as the content it cites — so a line
 * yields a list rather than a single chunk.
 */
function parseLine(raw: string): StreamChunk[] | "DONE" {
  if (!raw.startsWith("data:")) return []
  const payload = raw.slice(5).trim()
  if (!payload) return []
  if (payload === "[DONE]") return "DONE"
  let json: unknown
  try {
    json = JSON.parse(payload)
  } catch {
    return []
  }
  const obj = json as {
    error?: { message?: string }
    choices?: Array<{
      delta?: {
        content?: string
        annotations?: Array<{ type?: string; url_citation?: { url?: string; title?: string } }>
      }
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  if (obj.error) throw new Error(obj.error.message ?? "OpenAI stream error")

  const out: StreamChunk[] = []
  const delta = obj.choices?.[0]?.delta?.content
  if (typeof delta === "string" && delta.length) out.push({ type: "delta", text: delta })

  // Sources arrive on the spec channel `delta.annotations[].url_citation`.
  const annotations = obj.choices?.[0]?.delta?.annotations
  if (Array.isArray(annotations)) {
    const citations = toCitations(annotations)
    if (citations.length) out.push({ type: "citations", citations })
  }

  if (obj.usage && (obj.usage.prompt_tokens != null || obj.usage.completion_tokens != null)) {
    out.push({
      type: "usage",
      usage: {
        input_tokens: obj.usage.prompt_tokens ?? 0,
        output_tokens: obj.usage.completion_tokens ?? 0,
      },
    })
  }
  return out
}
