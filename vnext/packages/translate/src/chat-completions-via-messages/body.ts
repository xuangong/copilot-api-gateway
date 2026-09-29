import { TranslatorValidationError } from '../errors.ts'
/**
 * Non-streaming translator: hub Anthropic Messages JSON response → OpenAI
 * Chat Completions JSON response. Pairs with `./events.ts` for streamed
 * responses; this path is used when `stream: false`.
 *
 * Direction: response = hub → client.
 */
import type { MessagesResponse } from '@vibe-llm/protocols/messages'
import { messagesRefusalExplanation } from '../shared/messages-refusal.ts'

export interface ChatCompletionResponse {
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
      reasoning_opaque?: string
      reasoning_text?: string
      refusal?: string
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter'
  }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details?: { cached_tokens?: number } }
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (input == null) return '{}'
  try {
    return JSON.stringify(input)
  } catch {
    return '{}'
  }
}

function mapStopReason(stopReason: string | null | undefined): ChatCompletionResponse['choices'][0]['finish_reason'] {
  switch (stopReason) {
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'refusal':
      return 'content_filter'
    default:
      return 'stop'
  }
}

export function translateMessagesToChatBody(msg: MessagesResponse): ChatCompletionResponse {
  const textParts: string[] = []
  const reasoningParts: string[] = []
  let reasoningOpaque: string | undefined
  let reasoningBlocks = 0
  const toolCalls: NonNullable<ChatCompletionResponse['choices'][0]['message']['tool_calls']> = []

  const blocks = (msg.content ?? []) as Array<{
    type: string
    text?: string
    thinking?: string
    signature?: string
    id?: string
    name?: string
    input?: unknown
  }>
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text) textParts.push(block.text)
        break
      case 'redacted_thinking':
        throw new TranslatorValidationError('Redacted thinking cannot be represented by Chat.', 'content')
      case 'thinking':
        reasoningBlocks++
        if (typeof block.signature === 'string') reasoningOpaque = block.signature
        if (typeof block.thinking === 'string') reasoningParts.push(block.thinking)
        break
      case 'tool_use':
        if (block.id && block.name) {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: stringifyToolInput(block.input) },
          })
        }
        break
    }
  }

  if (reasoningBlocks > 1 && reasoningOpaque !== undefined) throw new TranslatorValidationError('Multiple signed reasoning blocks cannot be represented by Chat.', 'content')

  const usage = (msg.usage ?? {}) as {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  const cached = usage.cache_read_input_tokens ?? 0
  const promptTokens = (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0)
  const completionTokens = usage.output_tokens ?? 0

  return {
    id: msg.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: msg.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join('') : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(reasoningOpaque !== undefined ? { reasoning_opaque: reasoningOpaque } : {}),
          ...(reasoningParts.length > 0 ? { reasoning_text: reasoningParts.join('') } : {}),
          ...(msg.stop_reason === 'refusal' ? { refusal: messagesRefusalExplanation((msg as MessagesResponse & { stop_details?: { category?: string | null; explanation?: string | null } }).stop_details) } : {}),
        },
        finish_reason: mapStopReason(msg.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    },
  }
}
