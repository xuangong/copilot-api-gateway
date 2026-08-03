import { chatCompletionsErrorPayloadMessage } from '@vibe-llm/protocols/chat'
import type { ChatCompletionsStreamEvent, ChatCompletionsReasoningItem } from '@vibe-llm/protocols/chat'
import { captureExtras } from '../../shared/reassemble-extras.ts'

export interface ChatCompletionsResult {
  id: string
  /**
   * Always `'chat.completion'` — this is the static discriminator of the
   * OpenAI Chat Completions non-streaming envelope. The OpenAI SDK relies on
   * it to type-narrow the response, so we synthesize it unconditionally even
   * when upstream (Copilot's Azure) omits it. Matches
   * `copilot-gateway/packages/protocols/src/chat-completions/reassemble.ts`.
   */
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
      reasoning_text?: string
      reasoning_opaque?: string
      reasoning_items?: ChatCompletionsReasoningItem[]
      [k: string]: unknown
    }
    finish_reason: string
    [k: string]: unknown
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; [k: string]: unknown }
  [k: string]: unknown
}

// Known fields handled explicitly by the typed accumulators below. Anything
// outside these sets is vendor padding (Copilot `content_filter_results`,
// `prompt_filter_results`, `service_tier`, `copilot_usage`, `message.padding`,
// future OpenAI/Anthropic extensions) and flows through captureExtras so it
// reaches the client untouched. Mirrors copilot-gateway/.../reassemble.ts.
const KNOWN_CHUNK_KEYS: ReadonlySet<string> = new Set([
  'id', 'object', 'created', 'model', 'choices', 'usage', '__upstream_object',
])
const KNOWN_CHOICE_KEYS: ReadonlySet<string> = new Set(['index', 'delta', 'finish_reason'])
const KNOWN_DELTA_KEYS: ReadonlySet<string> = new Set([
  'content', 'role', 'reasoning_text', 'reasoning_opaque', 'reasoning_items', 'tool_calls',
])

// SSE chunks always carry `object: 'chat.completion.chunk'`. The synthesized
// `chat.completion` envelope's `object` field is stamped unconditionally in
// the final result (see below), so we don't need to track upstream's variant
// here — the `__upstream_object` sidecar from json-to-frames is ignored.
type ChunkWithSidecar = ChatCompletionsStreamEvent & { __upstream_object?: 'chat.completion' }

export async function reassembleChatCompletions(
  chunks: AsyncIterable<ChatCompletionsStreamEvent>,
): Promise<ChatCompletionsResult> {
  let id = ''
  let model = ''
  let created = 0
  let content = ''
  let reasoningText = ''
  let reasoningOpaque = ''
  let hasReasoningOpaque = false
  const reasoningItems: ChatCompletionsReasoningItem[] = []
  let finishReason: string = 'stop'
  let lastUsage: ChatCompletionsResult['usage'] | undefined

  const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>()
  const chunkExtras: Record<string, unknown> = {}
  const choiceExtras: Record<string, unknown> = {}
  const messageExtras: Record<string, unknown> = {}

  for await (const rawChunk of chunks) {
    const chunk = rawChunk as ChunkWithSidecar
    const errorMessage = chatCompletionsErrorPayloadMessage(chunk)
    if (errorMessage) {
      throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`)
    }

    if (!id && chunk.id) {
      id = chunk.id
      model = chunk.model
      created = chunk.created
    }

    if (chunk.usage) {
      lastUsage = chunk.usage as ChatCompletionsResult['usage']
    }

    captureExtras(chunk as unknown as Record<string, unknown>, KNOWN_CHUNK_KEYS, chunkExtras)

    const choices = chunk.choices as unknown as Array<Record<string, unknown>> | undefined
    if (!choices) continue

    for (const choice of choices) {
      captureExtras(choice, KNOWN_CHOICE_KEYS, choiceExtras)
      const delta = choice.delta as Record<string, unknown> | undefined
      if (!delta) continue
      captureExtras(delta, KNOWN_DELTA_KEYS, messageExtras)

      if (typeof delta.content === 'string') {
        content += delta.content
      }
      if (typeof delta.reasoning_text === 'string') {
        reasoningText += delta.reasoning_text
      }
      if (typeof delta.reasoning_opaque === 'string') {
        reasoningOpaque += delta.reasoning_opaque
        hasReasoningOpaque = true
      }
      if (Array.isArray(delta.reasoning_items)) {
        reasoningItems.push(...(delta.reasoning_items as ChatCompletionsReasoningItem[]))
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls as Array<Record<string, unknown>>) {
          const idx = toolCall.index as number
          const existing = toolCallsMap.get(idx)
          if (!existing) {
            toolCallsMap.set(idx, {
              id: (toolCall.id as string) ?? '',
              name: ((toolCall.function as Record<string, unknown>)?.name as string) ?? '',
              arguments: ((toolCall.function as Record<string, unknown>)?.arguments as string) ?? '',
            })
          } else {
            if (toolCall.id) existing.id = toolCall.id as string
            const fn = toolCall.function as Record<string, unknown> | undefined
            if (fn?.name) existing.name = fn.name as string
            if (fn?.arguments) {
              existing.arguments += fn.arguments as string
            }
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason as string
      }
    }
  }

  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  const sortedIndices = [...toolCallsMap.keys()].sort((a, b) => a - b)
  for (const idx of sortedIndices) {
    const toolCall = toolCallsMap.get(idx)!
    toolCalls.push({
      id: toolCall.id,
      type: 'function',
      function: { name: toolCall.name, arguments: toolCall.arguments },
    })
  }

  const message: ChatCompletionsResult['choices'][number]['message'] = {
    role: 'assistant',
    content: content || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    ...(reasoningText && { reasoning_text: reasoningText }),
    ...(hasReasoningOpaque ? { reasoning_opaque: reasoningOpaque } : {}),
    ...(reasoningItems.length > 0 && { reasoning_items: reasoningItems }),
    ...messageExtras,
  }

  const result: ChatCompletionsResult = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        ...choiceExtras,
      },
    ],
    ...(lastUsage && { usage: lastUsage }),
    ...chunkExtras,
  }

  return result
}
