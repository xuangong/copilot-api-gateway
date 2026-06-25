// vnext/packages/gateway/src/data-plane/chat-flow/responses/events/to-sse.ts
/**
 * Encode a `ProtocolFrame<ResponsesStreamEvent>` as an `SseFrame` ready for the
 * client. Responses SSE convention:
 *
 *   `event: <event.type>\ndata: <json>\n\n`
 *
 * No `[DONE]` terminator (the lifecycle envelope `response.completed` /
 * `response.incomplete` / `response.failed` is the terminator). The
 * `frame.type === 'done'` branch is unreachable for responses (the parser
 * never produces it and the synthesised non-stream branch never emits one
 * either) so we return `null` for it defensively — same shape as messages.
 */
import { sseFrame, type SseFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ResponsesStreamEvent } from '@vibe-llm/protocols/responses'

export const responsesProtocolFrameToSSEFrame = (
  frame: ProtocolFrame<ResponsesStreamEvent>,
): SseFrame | null => {
  if (frame.type === 'done') return null
  return sseFrame(JSON.stringify(frame.event), frame.event.type)
}
