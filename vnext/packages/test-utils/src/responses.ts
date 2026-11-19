/** A JSON response with `content-type: application/json`. */
export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
}

/**
 * A `text/event-stream` response. Pass raw SSE text, or a list of events that
 * are each written as one `data:` frame (objects are JSON-encoded).
 */
export function sseResponse(body: string | ReadonlyArray<unknown> = "data: [DONE]\n\n", status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string"
    ? body
    : body.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("")
  return new Response(text, { status, headers: { "content-type": "text/event-stream", ...headers } })
}
