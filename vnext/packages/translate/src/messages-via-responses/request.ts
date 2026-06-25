/**
 * Request translator: client Anthropic Messages payload → hub OpenAI Responses
 * payload.
 *
 * Direction: request = client → hub. Used when the client speaks /v1/messages
 * but the chosen model is served via /v1/responses (e.g. gpt-5.x). Mirrors the
 * pre-pivot reference at `src/translators/messages-via-responses/request.ts`.
 *
 * Faithful, minimal translation: knobs absent in the source are NOT
 * synthesized. Server-side `web_search` is mapped to the Responses hosted
 * tool; custom tools become Responses functions with `strict: false`.
 */
import type { MessagesPayload } from '@vibe-llm/protocols/messages'
import type { ResponsesPayload } from '@vibe-llm/protocols/responses'

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicImageBlock {
  type: 'image'
  source: { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string }
}
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input?: unknown }
interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<{ type: string; text?: string }>
}
interface AnthropicThinkingBlock { type: 'thinking'; thinking?: string }
type ContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock

interface MessageLike {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

interface MessagesTool { name: string; description?: string; input_schema?: unknown; type?: string }
interface AnthropicToolChoice { type?: 'auto' | 'any' | 'tool' | 'none'; name?: string }

type ResponseInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

type ResponseTool =
  | { type: 'web_search' }
  | { type: 'function'; name: string; description?: string; parameters?: unknown; strict: boolean }

type ResponseToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; name: string }

const MESSAGES_OPENAI_JSON_SCHEMA_NAME = 'messages_response'

interface PendingContent { type: string; [k: string]: unknown }

function flushPending(
  pending: PendingContent[],
  out: ResponseInputItem[],
  role: 'user' | 'assistant',
): void {
  if (pending.length === 0) return
  out.push({ type: 'message', role, content: [...pending] })
  pending.length = 0
}

function userContent(block: ContentBlock): PendingContent | null {
  if (block.type === 'text') return { type: 'input_text', text: block.text }
  if (block.type === 'image') {
    const src = block.source
    const url = src.type === 'base64' && src.media_type && src.data
      ? `data:${src.media_type};base64,${src.data}`
      : (src.url ?? '')
    return { type: 'input_image', text: url }
  }
  return null
}

function toolResultOutput(content: AnthropicToolResultBlock['content']): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  const allText = content.every((b): b is { type: 'text'; text?: string } => b.type === 'text')
  if (allText) return content.map((b) => b.text ?? '').join('\n\n')
  try {
    return JSON.stringify(content)
  } catch {
    return ''
  }
}

function functionCall(block: AnthropicToolUseBlock): ResponseInputItem {
  // Match copilot-gateway: only `call_id` is set on the request side. Upstream
  // /responses rejects non-`fc_*` ids, and the caller's tool_use id
  // (`call_…` / `toolu_…`) is only valid as `call_id`.
  let args = '{}'
  try {
    args = JSON.stringify(block.input ?? {})
  } catch {
    args = '{}'
  }
  return {
    type: 'function_call',
    call_id: block.id,
    name: block.name,
    arguments: args,
  }
}

function translateUserMessage(message: MessageLike): ResponseInputItem[] {
  if (typeof message.content === 'string') {
    return [{ type: 'message', role: 'user', content: message.content }]
  }
  const out: ResponseInputItem[] = []
  const pending: PendingContent[] = []
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      flushPending(pending, out, 'user')
      out.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: toolResultOutput(block.content),
      })
      continue
    }
    const c = userContent(block)
    if (c) pending.push(c)
  }
  flushPending(pending, out, 'user')
  return out
}

function translateAssistantMessage(message: MessageLike): ResponseInputItem[] {
  if (typeof message.content === 'string') {
    return [{ type: 'message', role: 'assistant', content: message.content }]
  }
  const out: ResponseInputItem[] = []
  const pending: PendingContent[] = []
  for (const block of message.content) {
    if (block.type === 'tool_use') {
      flushPending(pending, out, 'assistant')
      out.push(functionCall(block))
      continue
    }
    if (block.type === 'text') {
      pending.push({ type: 'output_text', text: block.text })
    }
    // thinking blocks are surface-output only — Responses input has no slot
    // for past reasoning, so they're dropped on the request side.
  }
  flushPending(pending, out, 'assistant')
  return out
}

function translateInput(messages: MessageLike[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = []
  for (const m of messages) {
    if (m.role === 'user') out.push(...translateUserMessage(m))
    else if (m.role === 'assistant') out.push(...translateAssistantMessage(m))
  }
  return out
}

function translateSystem(system: MessagesPayload['system']): string | undefined {
  if (typeof system === 'string') return system.length > 0 ? system : undefined
  if (!system) return undefined
  const blocks = system as Array<{ text?: string }>
  const text = blocks.map((b) => b.text ?? '').join('\n\n')
  return text.length > 0 ? text : undefined
}

function translateTools(tools: MessagesTool[] | undefined): ResponseTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map<ResponseTool>((t) => {
    // Anthropic's server-side web_search tool comes as
    // {type:"web_search_20250305", name:"web_search"}. Copilot's
    // /v1/responses upstream executes web_search natively as a hosted tool.
    if (t.name === 'web_search' || (typeof t.type === 'string' && t.type.startsWith('web_search'))) {
      return { type: 'web_search' }
    }
    return {
      type: 'function',
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema,
      strict: false,
    }
  })
}

function translateToolChoice(
  choice: AnthropicToolChoice | undefined,
  tools: MessagesTool[] | undefined,
): ResponseToolChoice | undefined {
  if (!choice || !tools || tools.length === 0) return undefined
  const names = new Set(tools.map((t) => t.name))
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'tool':
      return choice.name && names.has(choice.name)
        ? { type: 'function', name: choice.name }
        : 'auto'
    case 'none':
      return 'none'
    default:
      return undefined
  }
}

function translateEffort(payload: MessagesPayload): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  const cfg = (payload as MessagesPayload & { output_config?: { effort?: 'low' | 'medium' | 'high' | 'xhigh' } }).output_config
  if (cfg?.effort) return cfg.effort
  const thinking = payload.thinking as { budget_tokens?: number } | undefined
  const budget = thinking?.budget_tokens
  if (budget != null && budget > 0) {
    if (budget <= 2048) return 'low'
    if (budget <= 8192) return 'medium'
    return 'high'
  }
  return undefined
}

function translateOutputFormat(payload: MessagesPayload): { format: { type: 'json_schema'; name: string; strict: true; schema: Record<string, unknown> } } | undefined {
  const fmt = (payload as MessagesPayload & { output_config?: { format?: { type?: string; schema?: unknown } } }).output_config?.format
  if (!fmt || fmt.type !== 'json_schema') return undefined
  if (!fmt.schema || typeof fmt.schema !== 'object' || Array.isArray(fmt.schema)) return undefined
  return {
    format: {
      type: 'json_schema',
      name: MESSAGES_OPENAI_JSON_SCHEMA_NAME,
      strict: true,
      schema: fmt.schema as Record<string, unknown>,
    },
  }
}

export interface MessagesToResponsesRequestResult {
  target: ResponsesPayload
}

export function translateMessagesToResponses(payload: MessagesPayload): MessagesToResponsesRequestResult {
  const messages = payload.messages as unknown as MessageLike[]
  const tools = (payload.tools as unknown as MessagesTool[] | undefined)
  const ext = payload as MessagesPayload & {
    tool_choice?: AnthropicToolChoice
    metadata?: Record<string, string>
  }

  const instructions = translateSystem(payload.system)
  const effort = translateEffort(payload)
  const text = translateOutputFormat(payload)

  const target: Record<string, unknown> = {
    model: payload.model,
    input: translateInput(messages),
    max_output_tokens: payload.max_tokens,
    stream: payload.stream ?? true,
  }
  if (instructions !== undefined) target.instructions = instructions
  if (payload.temperature !== undefined) target.temperature = payload.temperature
  if (payload.top_p !== undefined) target.top_p = payload.top_p
  if (ext.metadata) target.metadata = { ...ext.metadata }
  if (tools !== undefined) {
    const translated = translateTools(tools)
    if (translated) target.tools = translated
    const tool_choice = translateToolChoice(ext.tool_choice, tools)
    if (tool_choice !== undefined) target.tool_choice = tool_choice
  }
  if (effort) target.reasoning = { effort }
  if (text) target.text = text

  return { target: target as unknown as ResponsesPayload }
}
