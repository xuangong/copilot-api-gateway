/**
 * Tiny helpers for emitting JSON 4xx/5xx envelopes from the chat-flow handlers.
 * Kept minimal so dispatch.ts and the per-endpoint http.ts files share the
 * same shape without re-declaring the headers each time.
 */
export function invalidJsonResponse(): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )
}

export const jsonErrorWrap = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
