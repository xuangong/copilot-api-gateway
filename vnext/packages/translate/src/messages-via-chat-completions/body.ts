/**
 * Non-streaming translator: hub OpenAI Chat Completions JSON response →
 * Anthropic Messages JSON response.
 *
 * Direction: response = hub → client.
 */
import type { MessagesResponse } from '@vibe-llm/protocols/messages'

interface ChatCompletionToolCall {
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

interface ChatCompletionMessage {
  role?: string
  content?: string | null
  tool_calls?: ChatCompletionToolCall[]
  reasoning_text?: string
}

interface ChatCompletionChoice {
  message?: ChatCompletionMessage
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
}

export interface ChatCompletionResultLike {
  id?: string
  model?: string
  choices?: ChatCompletionChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

function synthMessageId(): string {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  return `msg_${rand}`
}

function parseToolInput(args: string | undefined): Record<string, unknown> {
  if (!args) return {}
  try {
    const parsed = JSON.parse(args) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return {}
  }
}

function mapFinishReason(reason: ChatCompletionChoice['finish_reason']): string | null {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    default:
      return null
  }
}

export function translateChatBodyToMessages(resp: ChatCompletionResultLike, fallbackModel = ''): MessagesResponse {
  const choice = resp.choices?.[0]
  const msg = choice?.message ?? {}
  const blocks: Array<Record<string, unknown>> = []

  if (msg.reasoning_text) blocks.push({ type: 'thinking', thinking: msg.reasoning_text })
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    blocks.push({ type: 'text', text: msg.content })
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      if (!tc.id || !tc.function?.name) continue
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parseToolInput(tc.function.arguments),
      })
    }
  }

  const cached = resp.usage?.prompt_tokens_details?.cached_tokens ?? 0
  const promptTokens = resp.usage?.prompt_tokens ?? 0
  const inputTokens = Math.max(0, promptTokens - cached)

  return {
    id: resp.id ?? synthMessageId(),
    type: 'message',
    role: 'assistant',
    model: resp.model ?? fallbackModel,
    content: blocks as never,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: resp.usage?.completion_tokens ?? 0,
      ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
    } as never,
  } as unknown as MessagesResponse
}
