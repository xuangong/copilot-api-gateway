import { chatCompletionsErrorPayloadMessage } from '@vnext-llm/protocols/chat'
import type { ChatCompletionsStreamEvent, ChatCompletionsReasoningItem } from '@vnext-llm/protocols/chat'

export interface ChatCompletionsResult {
  id: string
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
    }
    finish_reason: string
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; [k: string]: unknown }
}

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

    if ((chunk as any).usage) {
      lastUsage = (chunk as any).usage as ChatCompletionsResult['usage']
    }

    const choices = (chunk as any).choices as unknown as Array<Record<string, unknown>> | undefined
    if (!choices) continue

    for (const choice of choices) {
      const delta = choice.delta as Record<string, unknown> | undefined
      if (!delta) continue

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
      },
    ],
    ...(lastUsage && { usage: lastUsage }),
  }

  return result
}
