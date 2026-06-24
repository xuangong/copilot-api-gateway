import { sseFrame, type SseFrame, type ProtocolFrame } from '@vnext-gateway/result'
import type { ChatCompletionsStreamEvent } from '@vnext-llm/protocols/chat'

export interface ChatCompletionsProtocolFrameToSSEFrameOptions {
  readonly includeUsageChunk: boolean
}

export const chatCompletionsProtocolFrameToSSEFrame = (
  frame: ProtocolFrame<ChatCompletionsStreamEvent>,
  options: ChatCompletionsProtocolFrameToSSEFrameOptions,
): SseFrame | null => {
  if ((frame as { kind?: string }).kind === 'translator-error') {
    const f = frame as unknown as { error?: string }
    return sseFrame(JSON.stringify({ error: { message: f.error ?? 'translator error' } }), 'error')
  }
  if (frame.type === 'done') return sseFrame('[DONE]')
  const ev = frame.event as { object?: unknown; choices?: unknown[]; usage?: unknown }
  // Drop usage-only chunks unless includeUsageChunk is set
  if (!options.includeUsageChunk && Array.isArray(ev.choices) && ev.choices.length === 0 && ev.usage !== undefined) return null
  // Drop the leading Azure-fronted prompt_filter_results-only frame: empty
  // choices, no usage, and missing the canonical `object: "chat.completion.chunk"`
  // discriminator. The OpenAI SDK's chunk parser rejects events without
  // `object`, and OpenAI's own API never emits this frame — it's purely
  // Azure-front noise that the legacy gateway also stripped.
  if (
    Array.isArray(ev.choices) && ev.choices.length === 0 &&
    ev.usage === undefined &&
    ev.object !== 'chat.completion.chunk'
  ) return null
  // Ensure each emitted chunk has the canonical `object` discriminator. Azure-
  // fronted Copilot upstream omits it on every frame; the OpenAI SDK rejects
  // chunks without it. Cheap fixup: synthesize when missing.
  const payload = ev.object === 'chat.completion.chunk' ? frame.event : { ...frame.event, object: 'chat.completion.chunk' }
  return sseFrame(JSON.stringify(payload))
}
