/**
 * Request translator: client Anthropic Messages payload → hub Gemini
 * generateContent payload.
 *
 * Composition: Messages → Chat Completions → Gemini. The Chat shape
 * normalizes role merging, system hoist, and tool_call accumulation
 * (Pair 2's responsibility); we then map Chat messages onto Gemini
 * contents/parts.
 *
 * Direction: request = client → hub.
 */
import type { GeminiPayload } from '@vnext-llm/protocols/gemini'
import type { MessagesPayload } from '@vnext-llm/protocols/messages'
import type { ChatPayload } from '@vnext-llm/protocols/chat'
import { translateMessagesToChat } from '../messages-via-chat-completions/index.ts'

export interface TranslateMessagesToGeminiOptions {
  /**
   * Optional override for the target model embedded in the resulting
   * Gemini payload. Defaults to the model declared in the Messages payload.
   */
  model?: string
}

// ─── Chat-shape (intermediate) ───

interface ChatContentPart {
  type: 'text' | 'image_url' | 'input_audio'
  text?: string
  image_url?: string | { url: string }
}
interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer'
  content?: string | ChatContentPart[] | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  reasoning_text?: string
}
interface ChatTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

// ─── Gemini target-shape (subset, mirrors gemini-via-messages source-shape) ───

interface GeminiTextPart { text: string }
interface GeminiInlinePart { inlineData: { mimeType: string; data: string } }
interface GeminiFunctionCallPart { functionCall: { name: string; args: Record<string, unknown> } }
interface GeminiFunctionResponsePart { functionResponse: { name: string; response: unknown } }
interface GeminiThoughtPart { text: string; thought: true }
type GeminiPart =
  | GeminiTextPart
  | GeminiInlinePart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart
  | GeminiThoughtPart

interface GeminiContent {
  role: 'user' | 'model' | 'function'
  parts: GeminiPart[]
}

interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

interface GeminiToolGroup { functionDeclarations?: GeminiFunctionDeclaration[] }

interface GeminiToolConfig {
  functionCallingConfig?: { mode?: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] }
}

interface GeminiThinkingConfig { thinkingBudget?: number }

interface GeminiGenerationConfig {
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  thinkingConfig?: GeminiThinkingConfig
}

// ─── Helpers ───

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/u.exec(url)
  if (!match) return null
  return { mimeType: match[1] ?? 'application/octet-stream', data: match[2] ?? '' }
}

function chatPartToGeminiPart(part: ChatContentPart): GeminiPart | null {
  if (part.type === 'text' && typeof part.text === 'string') {
    return { text: part.text }
  }
  if (part.type === 'image_url') {
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
    if (!url) return null
    const inline = parseDataUrl(url)
    if (inline) return { inlineData: inline }
    // Non-data URLs: drop. Gemini's inlineData requires base64.
    return null
  }
  return null
}

function chatContentToGeminiParts(content: ChatMessage['content']): GeminiPart[] {
  if (content == null) return []
  if (typeof content === 'string') return content ? [{ text: content }] : []
  const out: GeminiPart[] = []
  for (const part of content) {
    const mapped = chatPartToGeminiPart(part)
    if (mapped) out.push(mapped)
  }
  return out
}

function parseToolCallArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {}
  try {
    const parsed = JSON.parse(args) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fallthrough to empty args
  }
  return {}
}

function partsFromToolCalls(toolCalls: ChatToolCall[]): GeminiPart[] {
  return toolCalls.map((tc) => ({
    functionCall: { name: tc.function.name, args: parseToolCallArgs(tc.function.arguments) },
  }))
}

function appendUserMessage(messages: GeminiContent[], msg: ChatMessage): void {
  const parts = chatContentToGeminiParts(msg.content)
  if (parts.length === 0) return
  const last = messages.at(-1)
  if (last && last.role === 'user') {
    last.parts.push(...parts)
    return
  }
  messages.push({ role: 'user', parts })
}

function appendAssistantMessage(messages: GeminiContent[], msg: ChatMessage): void {
  const parts: GeminiPart[] = []
  if (msg.reasoning_text) parts.push({ text: msg.reasoning_text, thought: true })
  parts.push(...chatContentToGeminiParts(msg.content))
  if (msg.tool_calls?.length) parts.push(...partsFromToolCalls(msg.tool_calls))
  if (parts.length === 0) return
  messages.push({ role: 'model', parts })
}

function appendToolMessage(
  messages: GeminiContent[],
  msg: ChatMessage,
  toolUseIdToName: Map<string, string>,
): void {
  const toolCallId = msg.tool_call_id ?? ''
  // Pair 5's request.ts uses functionResponse.name as the canonical id link.
  // When the preceding assistant turn declared `tool_use { id, name }`, we
  // stored the name in toolUseIdToName so this tool message can carry the
  // function name (Gemini's identity model) instead of the synthetic id.
  const name = toolUseIdToName.get(toolCallId) ?? toolCallId
  let response: unknown = msg.content
  if (typeof response === 'string') {
    try {
      response = JSON.parse(response)
    } catch {
      // keep as string
    }
  }
  messages.push({ role: 'function', parts: [{ functionResponse: { name, response } }] })
}

function chatToGeminiContents(chat: ChatPayload): { systemText: string; contents: GeminiContent[] } {
  let systemText = ''
  const contents: GeminiContent[] = []
  const toolUseIdToName = new Map<string, string>()
  for (const m of chat.messages as ChatMessage[]) {
    if (m.role === 'system' || m.role === 'developer') {
      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('')
            : ''
      if (text) systemText = systemText ? `${systemText}\n\n${text}` : text
      continue
    }
    if (m.role === 'user') {
      appendUserMessage(contents, m)
      continue
    }
    if (m.role === 'assistant') {
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          toolUseIdToName.set(tc.id, tc.function.name)
        }
      }
      appendAssistantMessage(contents, m)
      continue
    }
    if (m.role === 'tool') {
      appendToolMessage(contents, m, toolUseIdToName)
    }
  }
  return { systemText, contents }
}

function chatToolsToGemini(tools: ChatPayload['tools']): GeminiToolGroup[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const fnDecls: GeminiFunctionDeclaration[] = []
  for (const t of tools) {
    const fn = (t as ChatTool).function
    if (!fn) continue
    const decl: GeminiFunctionDeclaration = { name: fn.name }
    if (fn.description) decl.description = fn.description
    if (fn.parameters && Object.keys(fn.parameters).length > 0) decl.parameters = fn.parameters
    fnDecls.push(decl)
  }
  if (fnDecls.length === 0) return undefined
  return [{ functionDeclarations: fnDecls }]
}

function chatToolChoiceToGemini(
  choice: ChatPayload['tool_choice'],
): GeminiToolConfig | undefined {
  if (choice === undefined) return undefined
  if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } }
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (typeof choice === 'object' && choice !== null) {
    const obj = choice as { type?: string; function?: { name?: string } }
    if (obj.type === 'function' && obj.function?.name) {
      return {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [obj.function.name],
        },
      }
    }
  }
  return undefined
}

function effortToBudget(effort: string | undefined): number | undefined {
  switch (effort) {
    case 'low':
      return 1024
    case 'medium':
      return 4096
    case 'high':
      return 16384
    default:
      return undefined
  }
}

export function translateMessagesToGemini(
  payload: MessagesPayload,
  options: TranslateMessagesToGeminiOptions = {},
): GeminiPayload {
  const chat = translateMessagesToChat(payload)
  const { systemText, contents } = chatToGeminiContents(chat)

  const genCfg: GeminiGenerationConfig = {}
  if (typeof chat.max_tokens === 'number') genCfg.maxOutputTokens = chat.max_tokens
  if (typeof chat.temperature === 'number') genCfg.temperature = chat.temperature
  if (typeof chat.top_p === 'number') genCfg.topP = chat.top_p
  if (chat.stop !== undefined) {
    genCfg.stopSequences = Array.isArray(chat.stop) ? chat.stop : [chat.stop]
  }
  const budget = effortToBudget(chat.reasoning_effort)
  if (budget != null) genCfg.thinkingConfig = { thinkingBudget: budget }

  const tools = chatToolsToGemini(chat.tools)
  const toolConfig = chatToolChoiceToGemini(chat.tool_choice)

  const out: Record<string, unknown> = {
    contents,
  }
  if (systemText) out.systemInstruction = { parts: [{ text: systemText }] }
  if (Object.keys(genCfg).length > 0) out.generationConfig = genCfg
  if (tools) out.tools = tools
  if (toolConfig) out.toolConfig = toolConfig
  // Embed model passthrough on a non-schema field so downstream code can read it.
  const model = options.model ?? payload.model
  if (model) (out as { _model?: string })._model = model
  return out as unknown as GeminiPayload
}
