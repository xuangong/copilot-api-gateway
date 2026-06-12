import type { ChatPayload } from '@vnext/protocols/chat'
import type { ResponsesPayload } from '@vnext/protocols/responses'

export interface TranslateChatToResponsesOptions {
  fallbackMaxOutputTokens?: number
}
export interface ChatToResponsesRequestResult { target: ResponsesPayload }

type ChatMessage = ChatPayload['messages'][number]

interface ResponsesMessageItem {
  type: 'message'
  role: 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string }>
}
interface ResponsesFunctionCallItem { type: 'function_call'; call_id: string; name: string; arguments: string }
interface ResponsesFunctionCallOutputItem { type: 'function_call_output'; call_id: string; output: string }
type ResponsesInputItem = ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesFunctionCallOutputItem

type ResponsesTool =
  | { type: 'function'; name: string; description?: string; parameters?: unknown; strict: boolean }

type ResponsesToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; name: string }

function partsToContent(parts: unknown[]): Array<{ type: string; text?: string }> {
  const out: Array<{ type: string; text?: string }> = []
  for (const p of parts) {
    const part = p as { type?: string; text?: string; image_url?: { url?: string } | string }
    if (part.type === 'text' && typeof part.text === 'string') {
      out.push({ type: 'input_text', text: part.text })
    } else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string'
        ? part.image_url
        : part.image_url?.url
      if (url) out.push({ type: 'input_image', text: url })
    }
  }
  return out
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content == null) return ''
  try { return JSON.stringify(content) } catch { return '' }
}

function translateInput(messages: ChatMessage[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = []
  for (const m of messages) {
    if (m.role === 'system') continue // hoisted to instructions
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ type: 'message', role: 'user', content: m.content })
      } else if (Array.isArray(m.content)) {
        out.push({ type: 'message', role: 'user', content: partsToContent(m.content) })
      }
      continue
    }
    if (m.role === 'assistant') {
      const am = m as ChatMessage & { tool_calls?: Array<{ id: string; function: { name: string; arguments?: string } }> }
      if (typeof am.content === 'string' && am.content.length > 0) {
        out.push({ type: 'message', role: 'assistant', content: am.content })
      }
      if (am.tool_calls) {
        for (const tc of am.tool_calls) {
          out.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments ?? '{}',
          })
        }
      }
      continue
    }
    if (m.role === 'tool') {
      const tm = m as ChatMessage & { tool_call_id: string; content: unknown }
      out.push({
        type: 'function_call_output',
        call_id: tm.tool_call_id,
        output: stringifyToolContent(tm.content),
      })
    }
  }
  return out
}

function joinSystem(messages: ChatMessage[]): string | undefined {
  const sys = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((s) => s.length > 0)
  if (sys.length === 0) return undefined
  return sys.join('\n\n')
}

function translateTools(tools: ChatPayload['tools']): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const out: ResponsesTool[] = []
  for (const t of tools) {
    if (t.type !== 'function') continue
    const fn = t.function
    const tool: ResponsesTool = {
      type: 'function',
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      parameters: fn.parameters,
      strict: false,
    }
    out.push(tool)
  }
  return out.length > 0 ? out : undefined
}

function translateToolChoice(choice: ChatPayload['tool_choice']): ResponsesToolChoice | undefined {
  if (choice === undefined) return undefined
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice
  if (typeof choice === 'object' && choice !== null && 'function' in choice) {
    const c = choice as { type?: string; function: { name: string } }
    return { type: 'function', name: c.function.name }
  }
  return undefined
}

export function translateChatToResponses(
  payload: ChatPayload,
  options?: TranslateChatToResponsesOptions,
): ChatToResponsesRequestResult {
  const messages = payload.messages
  const target: Record<string, unknown> = {
    model: payload.model,
    input: translateInput(messages),
    stream: payload.stream ?? true,
  }
  const instructions = joinSystem(messages)
  if (instructions !== undefined) target.instructions = instructions
  if (payload.temperature !== undefined) target.temperature = payload.temperature
  if (payload.top_p !== undefined) target.top_p = payload.top_p
  const ext = payload as ChatPayload & { metadata?: Record<string, string> }
  if (ext.metadata) target.metadata = { ...ext.metadata }
  const tools = translateTools(payload.tools)
  if (tools) target.tools = tools
  const tc = translateToolChoice(payload.tool_choice)
  if (tc !== undefined) target.tool_choice = tc
  const cap = payload.max_tokens ?? options?.fallbackMaxOutputTokens
  if (cap !== undefined) target.max_output_tokens = cap
  return { target: target as unknown as ResponsesPayload }
}
