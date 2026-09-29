import type { ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { createResponsesTurn, isResponsesTurnTerminal, responsesTerminalBody, type ResponsesTurn, type ResponsesTurnOptions, type RespondResponsesInput } from "./turn"
import { COMMENT_KEEPALIVE_FRAME, startSseKeepalive } from "../shared/sse-keepalive"

export type { CompletedResponsesSnapshot, ResponsesCompletionWriter, RespondResponsesInput } from "./turn"
export type RespondResponsesOptions = ResponsesTurnOptions
const encoder = new TextEncoder()

/** HTTP is only a consumer of the canonical source. WS can consume turn.events
 * directly, without going through this serialization boundary. */
export async function renderResponsesTurn(turn: ResponsesTurn): Promise<Response> {
  const metadata = await turn.ready
  const headers = metadata.headers ?? new Headers()
  headers.delete("content-length")
  if (!turn.wantsStream || metadata.status >= 400) {
    headers.set("content-type", "application/json")
    let body: unknown = metadata.body
    let failed = metadata.status >= 400
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([(async () => {
        for await (const event of turn.events) {
          if (event.type === "error") failed = true
          if (isResponsesTurnTerminal(event)) {
            body = responsesTerminalBody(event)
            turn.recordSentPayloadBytes(encoder.encode(JSON.stringify(body)).byteLength)
          }
        }
      })(), new Promise<void>(resolve => {
        onAbort = () => { failed = true; body = { error: { type: "api_error", message: "Response cancelled." } }; resolve() }
        turn.abortController.signal.addEventListener("abort", onAbort, { once: true })
        if (turn.abortController.signal.aborted) onAbort()
      })])
    } finally { if (onAbort) turn.abortController.signal.removeEventListener("abort", onAbort) }
    headers.set("content-type", "application/json")
    return Response.json(body, { status: metadata.status >= 400 ? metadata.status : failed ? 502 : metadata.status, headers })
  }
  headers.set("content-type", "text/event-stream")
  headers.set("cache-control", "no-cache")
  headers.set("connection", "keep-alive")
  headers.set("x-accel-buffering", "no")
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const keepalive = startSseKeepalive(controller, COMMENT_KEEPALIVE_FRAME)
      let closed = false
      const close = (): void => { if (!closed && !cancelled) { closed = true; controller.close() } }
      const onAbort = (): void => { keepalive.stop(); close() }
      turn.abortController.signal.addEventListener("abort", onAbort, { once: true })
      if (turn.abortController.signal.aborted) onAbort()
      try {
        for await (const event of turn.events) {
          if (cancelled || turn.abortController.signal.aborted) break
          if (isResponsesTurnTerminal(event)) keepalive.stop()
          const bytes = encode(event)
          turn.recordSentPayloadBytes(bytes.byteLength)
          controller.enqueue(bytes)
          keepalive.touch()
        }
      } finally {
        keepalive.stop()
        turn.abortController.signal.removeEventListener("abort", onAbort)
        close()
      }
    },
    cancel() { cancelled = true; turn.abortController.abort() },
  })
  return new Response(body, { status: metadata.status, headers })
}

function encode(event: ResponsesStreamEvent): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

export async function respondResponses(result: RespondResponsesInput, options: ResponsesTurnOptions): Promise<Response> {
  return renderResponsesTurn(createResponsesTurn(result, options))
}
