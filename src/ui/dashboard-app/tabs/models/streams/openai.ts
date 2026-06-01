export async function* parseOpenAIStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
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
        if (!raw.startsWith("data:")) continue
        const payload = raw.slice(5).trim()
        if (!payload) continue
        if (payload === "[DONE]") return
        let json: unknown
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        const obj = json as {
          error?: { message?: string }
          choices?: Array<{ delta?: { content?: string } }>
        }
        if (obj.error) {
          throw new Error(obj.error.message ?? "OpenAI stream error")
        }
        const delta = obj.choices?.[0]?.delta?.content
        if (typeof delta === "string" && delta.length) yield delta
      }
    }
    const tail = buf.replace(/\r$/, "")
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim()
      if (payload && payload !== "[DONE]") {
        try {
          const json = JSON.parse(payload) as {
            error?: { message?: string }
            choices?: Array<{ delta?: { content?: string } }>
          }
          if (json.error) {
            throw new Error(json.error.message ?? "OpenAI stream error")
          }
          const delta = json.choices?.[0]?.delta?.content
          if (typeof delta === "string" && delta.length) yield delta
        } catch (e) {
          if (e instanceof Error && e.message.includes("OpenAI stream error")) throw e
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
