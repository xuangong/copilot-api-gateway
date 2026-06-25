/**
 * Pairwise translator: client speaks Anthropic Messages, hub speaks
 * OpenAI Chat Completions.
 *
 * Direction: request = client → hub.
 *
 * `tools` here is filtered to "client" tools (no `type` or `type: "custom"`).
 * Anthropic-specific server tools (web_search_*, computer_*) are dropped
 * because they have no Chat Completions analogue.
 */
import type { ChatPayload } from '@vibe-llm/protocols/chat'
import type { MessagesPayload } from '@vibe-llm/protocols/messages'

type ChatMessage = ChatPayload['messages'][number]

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicImageBlock { type: 'image'; source: { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string } }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input?: unknown }
interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content?: unknown }
interface AnthropicThinkingBlock { type: 'thinking'; thinking?: string }
type ContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock

const FINISH_BUDGET_TO_EFFORT = (budget: number): 'low' | 'medium' | 'high' => {
  if (budget <= 2048) return 'low'
  if (budget <= 8192) return 'medium'
  return 'high'
}

function isText(b: { type?: string }): b is AnthropicTextBlock { return b.type === 'text' }
function isImage(b: { type?: string }): b is AnthropicImageBlock { return b.type === 'image' }

function imageBlockToChatPart(block: AnthropicImageBlock): { type: 'image_url'; image_url: { url: string } } | null {
  const src = block.source
  if (!src) return null
  if (src.type === 'base64' && src.media_type && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } }
  }
  if (src.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: src.url } }
  }
  return null
}

function toChatUserContent(content: string | ContentBlock[]): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> {
  if (typeof content === 'string') return content
  const blocks = (content as Array<{ type?: string; text?: string }>) ?? []
  const hasImage = blocks.some((b) => b.type === 'image')
  if (!hasImage) {
    return blocks
      .filter((b): b is AnthropicTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n')
  }
  const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
  for (const block of blocks as ContentBlock[]) {
    if (isText(block)) {
      parts.push({ type: 'text', text: block.text })
      continue
    }
    if (!isImage(block)) continue
    const part = imageBlockToChatPart(block)
    if (part) parts.push(part)
  }
  return parts
}

function toChatToolResultContent(content: AnthropicToolResultBlock['content']): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  if (Array.isArray(content)) {
    const blocks = content as Array<{ type?: string; text?: string }>
    if (blocks.every((b) => b.type === 'text')) {
      return blocks.map((b) => b.text ?? '').join('\n\n')
    }
    try {
      return JSON.stringify(content)
    } catch {
      return ''
    }
  }
  try {
    return JSON.stringify(content)
  } catch {
    return ''
  }
}

interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; [k: string]: unknown }

function toChatToolCall(block: AnthropicToolUseBlock): ChatToolCall {
  let args = '{}'
  try {
    args = JSON.stringify(block.input ?? {})
  } catch {
    args = '{}'
  }
  return { id: block.id, type: 'function', function: { name: block.name, arguments: args } }
}

interface PendingAssistant { textParts: string[]; toolCalls: ChatToolCall[]; reasoningText: string | null }

function flushAssistant(messages: ChatMessage[], pending: PendingAssistant): void {
  if (
    pending.textParts.length === 0
    && pending.toolCalls.length === 0
    && pending.reasoningText === null
  ) return
  const msg: ChatMessage = {
    role: 'assistant',
    content: pending.textParts.length > 0 ? pending.textParts.join('\n\n') : null,
    ...(pending.toolCalls.length > 0 ? { tool_calls: [...pending.toolCalls] } : {}),
    ...(pending.reasoningText !== null ? ({ reasoning_text: pending.reasoningText } as Partial<ChatMessage>) : {}),
  }
  messages.push(msg)
  pending.textParts.length = 0
  pending.toolCalls.length = 0
  pending.reasoningText = null
}

function translateUserMessage(role: 'user', content: string | ContentBlock[]): ChatMessage[] {
  if (!Array.isArray(content)) return [{ role, content: toChatUserContent(content) } as ChatMessage]
  const out: ChatMessage[] = []
  const pending: ContentBlock[] = []
  const flush = () => {
    if (pending.length === 0) return
    out.push({ role: 'user', content: toChatUserContent(pending) } as ChatMessage)
    pending.length = 0
  }
  for (const block of content) {
    if (block.type !== 'tool_result') {
      pending.push(block)
      continue
    }
    flush()
    const tr = block as AnthropicToolResultBlock
    out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: toChatToolResultContent(tr.content) } as ChatMessage)
  }
  flush()
  return out
}

function translateAssistantMessage(content: string | ContentBlock[]): ChatMessage[] {
  if (!Array.isArray(content)) return [{ role: 'assistant', content } as ChatMessage]
  const pending: PendingAssistant = { textParts: [], toolCalls: [], reasoningText: null }
  for (const block of content) {
    switch (block.type) {
      case 'text':
        pending.textParts.push((block as AnthropicTextBlock).text)
        break
      case 'thinking':
        pending.reasoningText ??= (block as AnthropicThinkingBlock).thinking ?? null
        break
      case 'tool_use':
        pending.toolCalls.push(toChatToolCall(block as AnthropicToolUseBlock))
        break
    }
  }
  const out: ChatMessage[] = []
  flushAssistant(out, pending)
  return out
}

function translateInput(messages: MessagesPayload['messages'], system: MessagesPayload['system']): ChatMessage[] {
  const sys: ChatMessage[] = []
  if (system) {
    const text =
      typeof system === 'string'
        ? system
        : (system as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n\n')
    if (text) sys.push({ role: 'system', content: text } as ChatMessage)
  }
  const out: ChatMessage[] = [...sys]
  for (const m of messages) {
    if (m.role === 'user') {
      out.push(...translateUserMessage('user', m.content as string | ContentBlock[]))
    } else if (m.role === 'assistant') {
      out.push(...translateAssistantMessage(m.content as string | ContentBlock[]))
    }
  }
  return out
}

interface MessagesTool { name: string; description?: string; input_schema?: unknown; type?: string }
interface ChatTool { type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }

function translateTools(tools: MessagesPayload['tools']): ChatTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const list = tools as MessagesTool[]
  const client = list.filter((t) => t.type === undefined || t.type === 'custom')
  if (client.length === 0) return undefined
  return client.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.input_schema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    },
  }))
}

interface AnthropicToolChoice { type?: 'auto' | 'any' | 'tool' | 'none'; name?: string }
type ChatToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }

function translateToolChoice(choice: AnthropicToolChoice | undefined, tools: ChatTool[] | undefined): ChatToolChoice | undefined {
  if (!choice || !tools || tools.length === 0) return undefined
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      if (!choice.name) return undefined
      return tools.some((t) => t.function.name === choice.name)
        ? { type: 'function', function: { name: choice.name } }
        : undefined
    default:
      return undefined
  }
}

function translateEffort(payload: MessagesPayload): 'low' | 'medium' | 'high' | undefined {
  const thinking = payload.thinking as { budget_tokens?: number } | undefined
  const budget = thinking?.budget_tokens
  if (budget != null && budget > 0) return FINISH_BUDGET_TO_EFFORT(budget)
  return undefined
}

export function translateMessagesToChat(payload: MessagesPayload): ChatPayload {
  const tools = translateTools(payload.tools)
  const reasoning_effort = translateEffort(payload)
  const messages = translateInput(payload.messages as MessagesPayload['messages'], payload.system)
  const ext = payload as MessagesPayload & { temperature?: number; top_p?: number; stop_sequences?: string[]; tool_choice?: AnthropicToolChoice }

  const out: Record<string, unknown> = {
    model: payload.model,
    messages,
    max_tokens: payload.max_tokens,
    stream: payload.stream ?? true,
  }
  if (reasoning_effort !== undefined) out.reasoning_effort = reasoning_effort
  if (ext.temperature !== undefined) out.temperature = ext.temperature
  if (ext.top_p !== undefined) out.top_p = ext.top_p
  if (ext.stop_sequences && ext.stop_sequences.length > 0) out.stop = ext.stop_sequences
  if (tools) out.tools = tools
  const toolChoice = translateToolChoice(ext.tool_choice, tools)
  if (toolChoice !== undefined) out.tool_choice = toolChoice
  return out as unknown as ChatPayload
}
