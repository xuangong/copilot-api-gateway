import { Buffer } from "node:buffer"
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
    let serialized: { body: unknown; json: string | undefined } | undefined
    let failed = metadata.status >= 400
    let onAbort: (() => void) | undefined
    const delivered = Promise.withResolvers<void>()
    try {
      await Promise.race([(async () => {
        for await (const event of turn.events) {
          if (event.type === "error") failed = true
          if (isResponsesTurnTerminal(event)) {
            body = responsesTerminalBody(event)
            serialized = { body, json: JSON.stringify(body) }
            turn.recordSentPayloadBytes(serialized.json === undefined ? 0 : Buffer.byteLength(serialized.json, "utf8"))
            // The canonical terminal already passed tail validation and snapshot
            // persistence. Keep draining under turn.completion/waitUntil, without
            // charging usage/metrics/dump storage latency to HTTP delivery.
            delivered.resolve()
          }
        }
      })(), delivered.promise, new Promise<void>(resolve => {
        onAbort = () => { failed = true; body = { error: { type: "api_error", message: "Response cancelled." } }; resolve() }
        turn.abortController.signal.addEventListener("abort", onAbort, { once: true })
        if (turn.abortController.signal.aborted) onAbort()
      })])
    } finally { if (onAbort) turn.abortController.signal.removeEventListener("abort", onAbort) }
    headers.set("content-type", "application/json")
    const init = { status: metadata.status >= 400 ? metadata.status : failed ? 502 : metadata.status, headers }
    // Reuse the counted JSON without a second serialization or counting buffer.
    // Abort may replace the body; undefined JSON retains native platform behavior.
    return serialized && serialized.body === body && serialized.json !== undefined
      ? new Response(serialized.json, init)
      : Response.json(body, init)
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
          if (isResponsesTurnTerminal(event)) close()
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
