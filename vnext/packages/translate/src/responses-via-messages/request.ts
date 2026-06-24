/**
 * Request translator: client OpenAI Responses payload → hub Anthropic Messages
 * payload.
 *
 * Used when the client speaks /v1/responses but the chosen model serves
 * /v1/messages natively. Faithful, minimal translation: absent knobs are not
 * synthesized. Mirrors the pre-pivot reference at
 * `src/translators/responses-via-messages/request.ts`.
 */
import type { MessagesPayload } from '@vnext-llm/protocols/messages'
import type { ResponsesPayload } from '@vnext-llm/protocols/responses'
import {
  applyLastMessageCacheBreakpoint,
  applyLastToolCacheBreakpoint,
  systemWithCacheBreakpoint,
  type MessageLike as SharedMessageLike,
} from '../shared/cache-breakpoints.ts'

const DEFAULT_MAX_TOKENS = 8192

interface ContentBlockLike { type: string; text?: string; cache_control?: unknown }
interface MessageLike {
  role: 'user' | 'assistant'
  content: string | ContentBlockLike[]
}
interface ToolLike { name: string; description?: string; input_schema?: unknown; type?: string }

interface ResponsesMessageItem {
  type: 'message'
  role: 'user' | 'assistant' | 'system' | 'developer'
  content: string | Array<{ type: string; text?: string }>
}

interface ResponsesFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments?: string
}

interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output?: string
}

function extractSystemText(message: ResponsesMessageItem): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content.map((b) => b.text ?? '').join('')
}

function translateUserContent(
  blocks: Array<{ type: string; text?: string }>,
): ContentBlockLike[] {
  const out: ContentBlockLike[] = []
  for (const block of blocks) {
    if (block.type === 'input_text') {
      out.push({ type: 'text', text: block.text ?? '' })
    }
    // input_image / input_file dropped: no faithful Anthropic conversion
    // available without a media_type lookup.
  }
  return out
}

function translateAssistantContent(
  blocks: Array<{ type: string; text?: string }>,
): ContentBlockLike[] {
  const out: ContentBlockLike[] = []
  for (const block of blocks) {
    if (block.type === 'output_text') {
      out.push({ type: 'text', text: block.text ?? '' })
    }
  }
  return out
}

function parseToolArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {}
  try {
    const v = JSON.parse(args) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    return { raw_arguments: args }
  } catch {
    return { raw_arguments: args }
  }
}

function appendAssistantBlock(messages: MessageLike[], block: ContentBlockLike): void {
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    last.content.push(block)
    return
  }
  messages.push({ role: 'assistant', content: [block] })
}

function appendUserBlock(messages: MessageLike[], block: ContentBlockLike): void {
  const last = messages[messages.length - 1]
  if (last?.role === 'user' && Array.isArray(last.content)) {
    last.content.push(block)
    return
  }
  messages.push({ role: 'user', content: [block] })
}

interface TranslatedInput {
  messages: MessageLike[]
  systemParts: string[]
}

function translateInput(input: ResponsesPayload['input']): TranslatedInput {
  if (typeof input === 'string') {
    return { messages: [{ role: 'user', content: input }], systemParts: [] }
  }
  const messages: MessageLike[] = []
  const systemParts: string[] = []
  for (const raw of input as Array<{ type: string }>) {
    const item = raw as unknown as ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesFunctionCallOutputItem
    switch (item.type) {
      case 'message': {
        const msg = item
        if (msg.role === 'system' || msg.role === 'developer') {
          const text = extractSystemText(msg)
          if (text) systemParts.push(text)
          continue
        }
        const blocks: ContentBlockLike[] = typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : msg.role === 'user'
            ? translateUserContent(msg.content)
            : translateAssistantContent(msg.content)
        if (blocks.length > 0) {
          messages.push({ role: msg.role as 'user' | 'assistant', content: blocks })
        }
        break
      }
      case 'function_call': {
        const fc = item
        appendAssistantBlock(messages, {
          type: 'tool_use',
          id: fc.call_id,
          name: fc.name,
          input: parseToolArgs(fc.arguments),
        } as unknown as ContentBlockLike)
        break
      }
      case 'function_call_output': {
        const fco = item
        appendUserBlock(messages, {
          type: 'tool_result',
          tool_use_id: fco.call_id,
          content: fco.output,
        } as unknown as ContentBlockLike)
        break
      }
    }
  }
  return { messages, systemParts }
}

interface ResponsesToolLike { type?: string; name?: string; description?: string; parameters?: unknown }

function translateTools(tools: ResponsesPayload['tools']): ToolLike[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const out: ToolLike[] = []
  for (const raw of tools as ResponsesToolLike[]) {
    if (raw.type !== 'function' || !raw.name) continue
    out.push({
      name: raw.name,
      ...(raw.description ? { description: raw.description } : {}),
      ...(raw.parameters ? { input_schema: raw.parameters } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

interface MessagesToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none'
  name?: string
}

function translateToolChoice(choice: ResponsesPayload['tool_choice']): MessagesToolChoice | undefined {
  if (choice == null) return undefined
  if (typeof choice === 'string') {
    switch (choice) {
      case 'auto':
        return { type: 'auto' }
      case 'none':
        return { type: 'none' }
      case 'required':
        return { type: 'any' }
      default:
        return undefined
    }
  }
  const obj = choice as { type?: string; name?: string }
  if ((obj.type === 'function' || obj.type === 'custom') && obj.name) {
    return { type: 'tool', name: obj.name }
  }
  return undefined
}

export interface ResponsesToMessagesRequestResult {
  target: MessagesPayload
}

export function translateResponsesToMessages(payload: ResponsesPayload): ResponsesToMessagesRequestResult {
  const { messages, systemParts } = translateInput(payload.input)

  const systemPieces = [payload.instructions, ...systemParts].filter(
    (p): p is string => Boolean(p),
  )
  const reasoning = payload.reasoning as { effort?: string } | undefined
  const effort = reasoning?.effort
  const max_tokens = payload.max_output_tokens ?? DEFAULT_MAX_TOKENS

  const tools = translateTools(payload.tools)
  const tool_choice = translateToolChoice(payload.tool_choice)

  applyLastToolCacheBreakpoint(tools)
  applyLastMessageCacheBreakpoint(messages as unknown as SharedMessageLike[])

  // output_config: bundle reasoning effort + structured-output schema.
  const text = payload.text as { format?: { type?: string; schema?: unknown } } | undefined
  const responsesFormat = text?.format
  const formatSchema =
    responsesFormat?.type === 'json_schema'
    && responsesFormat.schema
    && typeof responsesFormat.schema === 'object'
    && !Array.isArray(responsesFormat.schema)
      ? (responsesFormat.schema as Record<string, unknown>)
      : undefined
  const outputConfig: Record<string, unknown> = {}
  if (effort) outputConfig.effort = effort
  if (formatSchema) outputConfig.format = { type: 'json_schema', schema: formatSchema }
  const hasOutputConfig = Object.keys(outputConfig).length > 0

  const systemText = systemPieces.length > 0 ? systemPieces.join('\n\n') : undefined
  const systemBlocks = systemWithCacheBreakpoint(systemText)

  const target: Record<string, unknown> = {
    model: payload.model,
    messages,
    max_tokens,
    stream: payload.stream ?? true,
    ...(systemBlocks ? { system: systemBlocks } : {}),
    ...(tools ? { tools } : {}),
    ...(hasOutputConfig ? { output_config: outputConfig } : {}),
  }
  if (payload.temperature != null) target.temperature = payload.temperature
  if (payload.top_p != null) target.top_p = payload.top_p
  if (tool_choice) target.tool_choice = tool_choice

  return { target: target as unknown as MessagesPayload }
}
