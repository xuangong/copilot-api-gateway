import { RESPONSES_WS_MAX_INBOUND_BYTES, utf8Bytes } from "./session-limits.ts"

export class ResponsesSessionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly closeCode?: number) { super(message) }
}
export interface ResponsesSessionCreate { readonly type: "response.create"; readonly raw: Record<string, unknown>; readonly warmup: boolean }
export interface ResponsesSessionInterrupt { readonly type: "response.interrupt"; readonly responseId: string }
export type ResponsesSessionMessage = ResponsesSessionCreate | ResponsesSessionInterrupt

export function parseResponsesSessionMessage(text: string): ResponsesSessionMessage {
  if (utf8Bytes(text) > RESPONSES_WS_MAX_INBOUND_BYTES) throw new ResponsesSessionError(413, "frame_too_large", "Response message exceeds the byte limit.", 1009)
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new ResponsesSessionError(400, "invalid_json", "Invalid JSON message.") }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResponsesSessionError(400, "invalid_request", "Expected a response.create or response.interrupt object.")
  const raw = value as Record<string, unknown>
  if (raw.type === "response.interrupt") {
    if (typeof raw.response_id !== "string" || !raw.response_id.trim()) throw new ResponsesSessionError(400, "invalid_request", "response.interrupt requires a response_id.")
    if (raw.mode !== "discard_partial_items") throw new ResponsesSessionError(400, "unsupported_feature", "Only discard_partial_items interruption is supported.")
    for (const field of Object.keys(raw)) {
      if (!["type", "response_id", "mode"].includes(field)) throw new ResponsesSessionError(400, "unsupported_feature", `Unsupported interruption field: ${field}.`)
    }
    return { type: "response.interrupt", responseId: raw.response_id }
  }
  if (raw.type !== "response.create") throw new ResponsesSessionError(400, "unsupported_event", "Only response.create and response.interrupt are supported.")
  for (const field of ["response", "stream_id", "event_id", "fork", "fork_from", "fork_response_id", "multiplex"]) {
    if (field in raw) throw new ResponsesSessionError(400, "unsupported_feature", `Unsupported WebSocket field: ${field}.`)
  }
  if ((raw.stream !== undefined && raw.stream !== true) || (raw.background !== undefined && raw.background !== false)
    || (raw.generate !== undefined && typeof raw.generate !== "boolean")) {
    throw new ResponsesSessionError(400, "unsupported_feature", "Unsupported stream, background or generate mode.")
  }
  const warmup = raw.generate === false
  if (warmup && raw.store !== undefined && raw.store !== false) throw new ResponsesSessionError(400, "unsupported_feature", "Warmup supports only connection-local store:false state.")
  const { type: _type, generate: _generate, background: _background, stream: _stream, ...payload } = raw
  return { type: "response.create", raw: { ...payload, ...(warmup ? { store: false } : {}), stream: true }, warmup }
}

export function responsesSessionErrorEvent(error: ResponsesSessionError): Record<string, unknown> {
  return { type: "error", status: error.status, error: { type: error.status === 401 ? "authentication_error" : error.status >= 500 ? "api_error" : "invalid_request_error", code: error.code, message: error.message } }
}
