// vnext/packages/gateway/src/data-plane/chat-flow/messages/events/to-sse.ts
/**
 * Encode a `ProtocolFrame<MessagesStreamEvent>` as an `SseFrame` ready for the
 * client. Anthropic Messages SSE convention:
 *
 *   `event: <type>\ndata: <json>\n\n`
 *
 * with `message_stop` as the terminator (no [DONE] sentinel). `frame.type ===
 * 'done'` is unreachable for messages — the parser produces `event` frames
 * exclusively and the synthesised non-stream branch never emits a done frame
 * either — so we return `null` for it defensively.
 */
import { sseFrame, type SseFrame, type ProtocolFrame } from '@vibe-core/result'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'

export const messagesProtocolFrameToSSEFrame = (
  frame: ProtocolFrame<MessagesStreamEvent>,
): SseFrame | null => {
  if (frame.type === 'done') return null
  return sseFrame(JSON.stringify(frame.event), frame.event.type)
}
