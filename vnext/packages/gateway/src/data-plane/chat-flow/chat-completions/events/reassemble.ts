import { chatCompletionsErrorPayloadMessage } from '@vibe-llm/protocols/chat'
import type { ChatCompletionsStreamEvent, ChatCompletionsReasoningItem } from '@vibe-llm/protocols/chat'
import { captureExtras } from '../../shared/reassemble-extras.ts'

export interface ChatCompletionsResult {
  id: string
  /**
   * Optional — omitted when not surfaced by upstream. Root project passes the
   * upstream JSON straight through without ever synthesizing this field, so
   * we leave it off here to keep the parity audit green ($.object diff).
   * captureExtras re-attaches it when upstream actually sends it.
   */
  object?: 'chat.completion'
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

export async function reassembleChatCompletions(
  chunks: AsyncIterable<ChatCompletionsStreamEvent>,
): Promise<ChatCompletionsResult> {
  let id = ''
  let model = ''
  let created = 0
  let upstreamObject: 'chat.completion' | undefined
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

  for await (const chunk of chunks) {
    const errorMessage = chatCompletionsErrorPayloadMessage(chunk)
    if (errorMessage) {
      throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`)
    }

    if (!id && (chunk as any).id) {
      id = (chunk as any).id as string
      model = (chunk as any).model as string
      created = (chunk as any).created as number
    }
    // Preserve the upstream `object` discriminator only when it's the
    // non-streaming form. SSE chunks always carry `chat.completion.chunk` and
    // must not become the result's object. Root passes upstream JSON through
    // verbatim, so when the upstream actually returned `chat.completion` (via
    // json-to-frames synthesizer) we need to echo it back to keep parity.
    if (upstreamObject === undefined) {
      const sidecar = (chunk as any).__upstream_object
      if (sidecar === 'chat.completion') {
        upstreamObject = 'chat.completion'
      } else {
        const candidate = (chunk as any).object
        if (candidate === 'chat.completion') upstreamObject = 'chat.completion'
      }
    }

    if ((chunk as any).usage) {
      lastUsage = (chunk as any).usage as ChatCompletionsResult['usage']
    }

    captureExtras(chunk as unknown as Record<string, unknown>, KNOWN_CHUNK_KEYS, chunkExtras)

    const choices = (chunk as any).choices as unknown as Array<Record<string, unknown>> | undefined
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
    ...(upstreamObject ? { object: upstreamObject } : {}),
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
