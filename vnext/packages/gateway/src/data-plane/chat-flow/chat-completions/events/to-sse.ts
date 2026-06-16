import { sseFrame, type SseFrame, type ProtocolFrame } from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'

export interface ChatCompletionsProtocolFrameToSSEFrameOptions {
  readonly includeUsageChunk: boolean
}

export const chatCompletionsProtocolFrameToSSEFrame = (
  frame: ProtocolFrame<ChatCompletionsStreamEvent>,
  options: ChatCompletionsProtocolFrameToSSEFrameOptions,
): SseFrame | null => {
  if (frame.type === 'done') return sseFrame('[DONE]')
  const ev = frame.event as { choices?: unknown[]; usage?: unknown; object?: string }
  if (!options.includeUsageChunk && Array.isArray(ev.choices) && ev.choices.length === 0 && ev.usage !== undefined) return null
  // Some upstreams (Azure-flavored Copilot) omit `object` on streaming chunks.
  // The OpenAI spec requires `chat.completion.chunk` so SDK clients can
  // discriminate. Patch when missing rather than mutating the source frame.
  const out = ev.object ? frame.event : { ...frame.event, object: 'chat.completion.chunk' }
  return sseFrame(JSON.stringify(out))
}
