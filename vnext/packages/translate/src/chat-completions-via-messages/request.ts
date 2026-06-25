/**
 * Pairwise translator: client speaks OpenAI Chat Completions, hub speaks
 * Anthropic Messages.
 *
 * Direction: request = client → hub (translateChatToMessages).
 *           events  = hub → client  (see ./events.ts).
 *
 * Image fetch: image_url parts referencing remote http(s) URLs are passed
 * through verbatim; this translator does NOT pre-fetch images to base64.
 */

import type { ChatPayload } from '@vibe-llm/protocols/chat'
import type { MessagesPayload } from '@vibe-llm/protocols/messages'
import {
  applyLastMessageCacheBreakpoint,
  applyLastToolCacheBreakpoint,
  systemWithCacheBreakpoint,
} from '../shared/cache-breakpoints.ts'
import { TranslatorValidationError } from '../errors.ts'

const MESSAGES_FALLBACK_MAX_TOKENS = 4096

export interface TranslateChatToMessagesOptions {
  /**
   * Preferred cap when the source payload omits `max_tokens`. Callers wire
   * the binding's model maxOutputTokens through this so the translated
   * Messages request reflects the upstream-known limit.
   */
  fallbackMaxOutputTokens?: number
}

type ChatMessage = ChatPayload['messages'][number]
type ChatContent = ChatMessage['content']

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicImageBlock { type: 'image'; source: { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string } }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content?: string }
type UserBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolResultBlock
type AssistantBlock = AnthropicTextBlock | AnthropicToolUseBlock
type ContentBlock = UserBlock | AssistantBlock
interface AnthropicMessage { role: 'user' | 'assistant'; content: string | ContentBlock[] }

const EFFORT_TO_BUDGET: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
}

const CHAT_TOOL_CHOICE: Record<string, { type: 'auto' | 'any' | 'none' }> = {
  auto: { type: 'auto' },
  required: { type: 'any' },
  none: { type: 'none' },
}

function parseToolArgs(s: string | undefined): Record<string, unknown> {
  if (!s) return {}
  try {
    const v = JSON.parse(s) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function coerceImageUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const url = (value as { url?: unknown }).url
    if (typeof url === 'string') return url
  }
  return undefined
}

function userBlocksFromContent(content: ChatContent): UserBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }]
  const out: UserBlock[] = []
  for (const part of content) {
    const p = part as { type?: string; text?: string; image_url?: unknown }
    if (p.type === 'text') {
      out.push({ type: 'text', text: p.text ?? '' })
      continue
    }
    if (p.type === 'image_url') {
      const url = coerceImageUrl(p.image_url)
      if (!url) continue
      if (url.startsWith('data:')) {
        const match = /^data:([^;]+);base64,(.+)$/.exec(url)
        if (match) {
          out.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
          continue
        }
      }
      out.push({ type: 'image', source: { type: 'url', url } })
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }]
}

function assistantBlocks(m: ChatMessage): AssistantBlock[] {
  const blocks: AssistantBlock[] = []
  if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content })
  for (const call of m.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolArgs(call.function.arguments),
    })
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}

function appendUser(out: AnthropicMessage[], blocks: UserBlock[]): void {
  const last = out[out.length - 1]
  if (last?.role === 'user') {
    const existing = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content as string }]
    last.content = [...(existing as ContentBlock[]), ...blocks]
    return
  }
  const first = blocks[0]
  const single = blocks.length === 1 && first && first.type === 'text'
  out.push({ role: 'user', content: single ? (first as AnthropicTextBlock).text : blocks })
}

function buildMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      appendUser(out, userBlocksFromContent(m.content))
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: assistantBlocks(m) })
    } else if (m.role === 'tool') {
      if (!m.tool_call_id) throw new TranslatorValidationError('tool message requires tool_call_id', 'tool_call_id')
      const tr: AnthropicToolResultBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : '',
      }
      appendUser(out, [tr])
    }
  }
  return out
}

interface ChatToolDef { type?: string; function: { name: string; description?: string; parameters?: unknown } }
interface MessagesToolDef { name: string; description?: string; input_schema: unknown }

function translateTools(tools: ChatToolDef[] | undefined): MessagesToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters ?? { type: 'object', properties: {} },
  }))
}

function translateToolChoice(choice: unknown): { type: 'auto' | 'any' | 'tool' | 'none'; name?: string } | undefined {
  if (choice === undefined) return undefined
  if (typeof choice === 'string') return CHAT_TOOL_CHOICE[choice]
  if (choice && typeof choice === 'object') {
    const c = choice as { type?: string; function?: { name?: string } }
    if (c.type === 'function' && c.function?.name) {
      return { type: 'tool', name: c.function.name }
    }
  }
  return undefined
}

export function translateChatToMessages(
  payload: ChatPayload,
  options: TranslateChatToMessagesOptions = {},
): MessagesPayload {
  const systemParts: string[] = []
  const nonSystem: ChatMessage[] = []
  for (const m of payload.messages) {
    if (m.role === 'system' || m.role === 'developer') {
      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((p) => (p as { type?: string }).type === 'text')
                .map((p) => (p as { text?: string }).text ?? '')
                .join('')
            : ''
      if (text) systemParts.push(text)
      continue
    }
    nonSystem.push(m)
  }

  const messages = buildMessages(nonSystem)
  const max_tokens =
    payload.max_tokens
    ?? payload.max_completion_tokens
    ?? options.fallbackMaxOutputTokens
    ?? MESSAGES_FALLBACK_MAX_TOKENS
  const toolChoice = translateToolChoice(payload.tool_choice)
  const tools = translateTools(payload.tools)
  const systemBlocks = systemWithCacheBreakpoint(
    systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
  )
  applyLastToolCacheBreakpoint(tools)
  applyLastMessageCacheBreakpoint(messages)
  const thinking = payload.reasoning_effort && EFFORT_TO_BUDGET[payload.reasoning_effort]
    ? { type: 'enabled' as const, budget_tokens: EFFORT_TO_BUDGET[payload.reasoning_effort] }
    : undefined

  const rf = payload.response_format as { type?: string; json_schema?: { schema?: unknown } } | undefined
  const formatSchema =
    rf?.type === 'json_schema'
    && rf.json_schema?.schema
    && typeof rf.json_schema.schema === 'object'
    && !Array.isArray(rf.json_schema.schema)
      ? (rf.json_schema.schema as Record<string, unknown>)
      : undefined
  const output_config = formatSchema
    ? { format: { type: 'json_schema' as const, schema: formatSchema } }
    : undefined

  const out: Record<string, unknown> = {
    model: payload.model,
    messages,
    max_tokens,
    stream: payload.stream ?? true,
  }
  if (systemBlocks) out.system = systemBlocks
  if (payload.temperature != null) out.temperature = payload.temperature
  if (payload.top_p != null) out.top_p = payload.top_p
  if (payload.stop != null) {
    out.stop_sequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop]
  }
  if (tools) out.tools = tools
  if (toolChoice) out.tool_choice = toolChoice
  if (thinking) out.thinking = thinking
  if (output_config) out.output_config = output_config
  return out as unknown as MessagesPayload
}
