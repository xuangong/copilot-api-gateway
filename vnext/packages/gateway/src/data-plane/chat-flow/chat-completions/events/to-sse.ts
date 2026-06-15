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
  const ev = frame.event as { choices?: unknown[]; usage?: unknown }
  if (!options.includeUsageChunk && Array.isArray(ev.choices) && ev.choices.length === 0 && ev.usage !== undefined) return null
  return sseFrame(JSON.stringify(frame.event))
}
