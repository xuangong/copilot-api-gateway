import { sseFrame, type SseFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ChatCompletionsStreamEvent } from '@vibe-llm/protocols/chat'

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
  // Ensure each emitted chunk has the canonical `object` discriminator. Azure-
  // fronted Copilot upstream omits it on every frame; the OpenAI SDK rejects
  // chunks without it. Cheap fixup: synthesize when missing. Root parity:
  // the leading `prompt_filter_results`-only frame (empty choices, no usage,
  // missing `object`) is preserved — root pipes the upstream SSE through
  // verbatim and emits this frame as event #1.
  const payload = ev.object === 'chat.completion.chunk' ? frame.event : { ...frame.event, object: 'chat.completion.chunk' }
  return sseFrame(JSON.stringify(payload))
}
