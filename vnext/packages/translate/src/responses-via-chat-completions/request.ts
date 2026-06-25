/**
 * Request translator: Responses client → Chat Completions upstream.
 *
 * Direction: request = client → hub. Used when the client speaks
 * /v1/responses but the chosen model is served via /v1/chat/completions.
 *
 * Faithful, minimal translation: knobs absent in the source are NOT
 * synthesized. Notable behaviors:
 *  - Responses `instructions` is hoisted to a leading `system` message.
 *  - `system`/`developer` input messages map to `system`; `user` and
 *    `assistant` map to their Chat counterparts. `input_text` parts become
 *    `text`; `input_image` parts become `image_url` with `{ url }`.
 *  - `function_call` items merge into the previous assistant message's
 *    `tool_calls` (or open a new assistant w/ `content: null`).
 *    `function_call_output` items become `role: 'tool'` messages.
 *  - Tools: only `type: 'function'` with a `name` survive (Responses
 *    hosted tools have no Chat analogue and are dropped).
 *  - `max_output_tokens` maps to `max_tokens`.
 */
import type { ChatPayload } from '@vibe-llm/protocols/chat'
import type { ResponsesPayload } from '@vibe-llm/protocols/responses'

export interface ResponsesToChatRequestResult { target: ChatPayload }

interface ResponsesInputMessage {
  type: 'message'
  role: 'user' | 'assistant' | 'system' | 'developer'
  content: string | Array<{ type: string; text?: string }>
}
interface ResponsesFunctionCall { type: 'function_call'; call_id: string; name: string; arguments?: string }
interface ResponsesFunctionCallOutput { type: 'function_call_output'; call_id: string; output?: string }
type ResponsesInputItem = ResponsesInputMessage | ResponsesFunctionCall | ResponsesFunctionCallOutput

interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatMsgUser { role: 'user'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }
interface ChatMsgAssistant { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
interface ChatMsgTool { role: 'tool'; tool_call_id: string; content: string }
interface ChatMsgSystem { role: 'system'; content: string }
type ChatMessage = ChatMsgUser | ChatMsgAssistant | ChatMsgTool | ChatMsgSystem

function partsToChat(parts: Array<{ type: string; text?: string }>): ChatMsgUser['content'] {
  const out: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  for (const p of parts) {
    if (p.type === 'input_text' && typeof p.text === 'string') out.push({ type: 'text', text: p.text })
    else if (p.type === 'input_image' && typeof p.text === 'string') out.push({ type: 'image_url', image_url: { url: p.text } })
  }
  return out
}

function translateInput(items: ResponsesInputItem[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const item of items) {
    if (item.type === 'message') {
      if (item.role === 'system' || item.role === 'developer') {
        const text = typeof item.content === 'string' ? item.content : item.content.map((p) => p.text ?? '').join('')
        if (text) out.push({ role: 'system', content: text })
        continue
      }
      if (item.role === 'user') {
        if (typeof item.content === 'string') out.push({ role: 'user', content: item.content })
        else out.push({ role: 'user', content: partsToChat(item.content) })
        continue
      }
      if (item.role === 'assistant') {
        const text = typeof item.content === 'string'
          ? item.content
          : item.content.map((p) => p.text ?? '').join('')
        out.push({ role: 'assistant', content: text })
        continue
      }
    }
    if (item.type === 'function_call') {
      // Merge into the previous assistant message if it has no tool_calls yet,
      // otherwise create a new assistant message with content:null.
      const prev = out[out.length - 1]
      const tc: ChatToolCall = {
        id: item.call_id, type: 'function',
        function: { name: item.name, arguments: item.arguments ?? '{}' },
      }
      if (prev && prev.role === 'assistant') {
        const a = prev as ChatMsgAssistant
        if (!a.tool_calls) a.tool_calls = []
        a.tool_calls.push(tc)
      } else {
        out.push({ role: 'assistant', content: null, tool_calls: [tc] })
      }
      continue
    }
    if (item.type === 'function_call_output') {
      out.push({ role: 'tool', tool_call_id: item.call_id, content: item.output ?? '' })
    }
  }
  return out
}

function translateTools(tools: ResponsesPayload['tools']): ChatPayload['tools'] | undefined {
  if (!tools) return undefined
  const out: NonNullable<ChatPayload['tools']> = []
  for (const t of tools as Array<{ type: string; name?: string; description?: string; parameters?: unknown }>) {
    if (t.type !== 'function' || !t.name) continue
    out.push({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
      },
    } as NonNullable<ChatPayload['tools']>[number])
  }
  return out.length > 0 ? out : undefined
}

function translateToolChoice(choice: ResponsesPayload['tool_choice']): ChatPayload['tool_choice'] | undefined {
  if (choice === undefined) return undefined
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice
  if (typeof choice === 'object' && (choice as { type?: string }).type === 'function') {
    const c = choice as { name: string }
    return { type: 'function', function: { name: c.name } } as NonNullable<ChatPayload['tool_choice']>
  }
  return undefined
}

export function translateResponsesToChat(payload: ResponsesPayload): ResponsesToChatRequestResult {
  const messages: ChatMessage[] = []
  if (typeof payload.instructions === 'string' && payload.instructions.length > 0) {
    messages.push({ role: 'system', content: payload.instructions })
  }
  const inputArr = (payload.input ?? []) as unknown as ResponsesInputItem[]
  messages.push(...translateInput(inputArr))

  const target: Record<string, unknown> = {
    model: payload.model,
    messages,
    stream: payload.stream ?? true,
  }
  if (payload.temperature !== undefined) target.temperature = payload.temperature
  if (payload.top_p !== undefined) target.top_p = payload.top_p
  const ext = payload as ResponsesPayload & { metadata?: Record<string, string> }
  if (ext.metadata) target.metadata = { ...ext.metadata }
  if (payload.max_output_tokens !== undefined) target.max_tokens = payload.max_output_tokens
  const tools = translateTools(payload.tools)
  if (tools) target.tools = tools
  const tc = translateToolChoice(payload.tool_choice)
  if (tc !== undefined) target.tool_choice = tc

  return { target: target as unknown as ChatPayload }
}
