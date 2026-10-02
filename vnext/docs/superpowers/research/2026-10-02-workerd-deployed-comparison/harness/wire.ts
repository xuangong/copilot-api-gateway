/** Parse complete host response bytes without invoking either semantic oracle. */
export function parseWireResponse(raw: string) {
  if (!raw.trim()) return { format: "empty", events: [] as unknown[], done: false }
  if (raw.trimStart().startsWith("{") || raw.trimStart().startsWith("[")) {
    const event: unknown = JSON.parse(raw)
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid JSON response object")
    return { format: "json", events: [event], done: false }
  }
  const normalized = raw.replaceAll("\r\n", "\n")
  const frames = normalized.split("\n\n")
  if (frames.pop()?.trim()) throw new Error("Incomplete trailing SSE frame")
  const events: unknown[] = []
  let done = false
  for (const frame of frames) {
    const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
    if (data === "[DONE]") { done = true; continue }
    if (!data) continue
    const event: unknown = JSON.parse(data)
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid SSE response object")
    events.push(event)
  }
  if (!events.length) throw new Error("Missing parsed response events")
  return { format: "sse", events, done }
}
