/**
 * Non-streaming body translator: hub OpenAI Responses JSON result → client
 * Anthropic Messages JSON response.
 *
 * Pairs with `./request.ts` and `./events.ts`. Mirrors the pre-pivot reference
 * at `src/translators/messages-via-responses/response.ts`.
 *
 * Direction: response = hub → client.
 */

import { assertClientRepresentableResponseItem } from "../shared/client-opaque-state.ts"

interface ResponsesResultLike {
  id: string
  model: string
  status?: 'completed' | 'incomplete' | 'failed' | 'in_progress'
  incomplete_details?: { reason?: string } | null
  output: Array<{
    type: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
    encrypted_content?: string
    summary?: Array<{ text?: string }>
    content?: Array<{ type: string; text?: string; refusal?: string }>
  }>
  output_text?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    // Both details are disjoint subsets of the inclusive `input_tokens`.
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  }
}

interface MessagesContentBlock {
  type: string
  [key: string]: unknown
}

export interface MessagesResponseLike {
  id: string
  type: 'message'
  role: 'assistant'
  content: MessagesContentBlock[]
  model: string
  stop_reason: string | null
  stop_sequence: null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

function parseToolArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {}
  try {
    const v = JSON.parse(args) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { raw_arguments: args }
  } catch {
    return { raw_arguments: args }
  }
}

function mapOutputToContent(output: ResponsesResultLike['output']): MessagesContentBlock[] {
  const blocks: MessagesContentBlock[] = []
  for (const item of output) {
    assertClientRepresentableResponseItem(item)
    switch (item.type) {
      case 'reasoning': {
        const thinking = (item.summary ?? [])
          .map((p) => p.text ?? '')
          .join('')
        if (thinking || item.summary?.length) blocks.push({ type: 'thinking', thinking, ...(item.encrypted_content !== undefined ? { signature: item.encrypted_content } : {}) })
        else if (item.encrypted_content !== undefined) blocks.push({ type: 'redacted_thinking', data: item.encrypted_content })
        break
      }
      case 'function_call':
        if (item.name && item.call_id) {
          blocks.push({
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: parseToolArgs(item.arguments),
          })
        }
        break
      case 'message': {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text') blocks.push({ type: 'text', text: part.text ?? '' })
          else if (part.type === 'refusal') blocks.push({ type: 'text', text: part.refusal ?? '' })
        }
        break
      }
    }
  }
  return blocks
}

function mapStopReason(resp: ResponsesResultLike): string | null {
  if (resp.status === 'incomplete' && resp.incomplete_details?.reason === 'max_output_tokens') {
    return 'max_tokens'
  }
  if (resp.status === 'completed') {
    if (resp.output.some((item) => item.type === 'message' && item.content?.some((part) => part.type === 'refusal'))) return 'refusal'
    return resp.output.some((i) => i.type === 'function_call') ? 'tool_use' : 'end_turn'
  }
  return null
}

export function translateResponsesToMessagesBody(resp: ResponsesResultLike): MessagesResponseLike {
  const content = mapOutputToContent(resp.output)
  const finalContent = content.length > 0
    ? content
    : resp.output_text
      ? [{ type: 'text', text: resp.output_text } as MessagesContentBlock]
      : []

  const cached = resp.usage?.input_tokens_details?.cached_tokens
  const cacheWrite = resp.usage?.input_tokens_details?.cache_write_tokens
  const inputTokens = Math.max(0, (resp.usage?.input_tokens ?? 0) - (cached ?? 0) - (cacheWrite ?? 0))

  return {
    id: resp.id,
    type: 'message',
    role: 'assistant',
    content: finalContent,
    model: resp.model,
    stop_reason: mapStopReason(resp),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: resp.usage?.output_tokens ?? 0,
      ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
      ...(cacheWrite !== undefined ? { cache_creation_input_tokens: cacheWrite } : {}),
    },
  }
}
