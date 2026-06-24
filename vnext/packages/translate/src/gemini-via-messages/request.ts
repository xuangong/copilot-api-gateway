/**
 * Request translator: client Gemini generateContent payload → hub Anthropic
 * Messages payload.
 *
 * Composition: Gemini → Chat Completions → Messages. The Gemini contents/parts
 * model maps cleanly onto Chat Completions messages, and Chat Completions →
 * Messages is the well-tested Pair 1 translator. Going through the
 * intermediate Chat shape avoids duplicating role-merge, function_call /
 * function_response, and inlineData plumbing.
 *
 * Direction: request = client → hub.
 */
import type { GeminiPayload } from '@vnext-llm/protocols/gemini'
import type { MessagesPayload } from '@vnext-llm/protocols/messages'
import type { ChatPayload } from '@vnext-llm/protocols/chat'
import { translateChatToMessages } from '../chat-completions-via-messages/index.ts'

export interface TranslateGeminiToMessagesOptions {
  /** Target model name to embed in the resulting Messages payload. */
  model: string
  /** Used by Pair 1 when source omits max_tokens. */
  fallbackMaxOutputTokens?: number
}

// ─── Gemini source-shape (subset) ───

interface GeminiTextPart { text: string }
interface GeminiInlinePart { inlineData: { mimeType: string; data: string } }
interface GeminiFunctionCallPart { functionCall: { name: string; args?: unknown } }
interface GeminiFunctionResponsePart { functionResponse: { name: string; response: unknown } }
type GeminiPart = GeminiTextPart | GeminiInlinePart | GeminiFunctionCallPart | GeminiFunctionResponsePart

interface GeminiContent {
  role?: 'user' | 'model' | 'function'
  parts: GeminiPart[]
}

interface GeminiThinkingConfig {
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
  thinkingBudget?: number
}

interface GeminiGenerationConfig {
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  candidateCount?: number
  responseMimeType?: string
  responseSchema?: Record<string, unknown>
  thinkingConfig?: GeminiThinkingConfig
}

interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

interface GeminiToolGroup {
  functionDeclarations?: GeminiFunctionDeclaration[]
}

interface GeminiToolConfig {
  functionCallingConfig?: { mode?: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] }
}

// ─── Chat-shape (intermediate) ───

interface ChatTool {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}
interface ChatContentPart { type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }
interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ChatContentPart[] | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
}

function extractText(parts: GeminiPart[]): string {
  return parts
    .filter((p): p is GeminiTextPart => 'text' in (p as object))
    .map((p) => p.text ?? '')
    .join('')
}

function partsHaveImage(parts: GeminiPart[]): boolean {
  return parts.some((p) => 'inlineData' in (p as object))
}

function partsHaveFunctionCall(parts: GeminiPart[]): boolean {
  return parts.some((p) => 'functionCall' in (p as object))
}

function partsToChatContent(parts: GeminiPart[]): string | ChatContentPart[] {
  if (!partsHaveImage(parts)) return extractText(parts)
  const out: ChatContentPart[] = []
  for (const p of parts) {
    if ('text' in (p as object)) out.push({ type: 'text', text: (p as GeminiTextPart).text })
    else if ('inlineData' in (p as object)) {
      const inl = (p as GeminiInlinePart).inlineData
      out.push({ type: 'image_url', image_url: { url: `data:${inl.mimeType};base64,${inl.data}` } })
    }
  }
  return out
}

function extractToolCalls(parts: GeminiPart[]): ChatToolCall[] {
  return parts
    .filter((p): p is GeminiFunctionCallPart => 'functionCall' in (p as object))
    .map((p, idx) => ({
      id: `call_${p.functionCall.name}_${idx}`,
      type: 'function' as const,
      function: {
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args ?? {}),
      },
    }))
}

function appendContentMessages(content: GeminiContent, messages: ChatMessage[]): void {
  // function role messages translate to one tool message per functionResponse.
  if (content.role === 'function') {
    for (const part of content.parts) {
      if ('functionResponse' in (part as object)) {
        const fr = (part as GeminiFunctionResponsePart).functionResponse
        messages.push({
          role: 'tool',
          tool_call_id: fr.name,
          content: typeof fr.response === 'string' ? fr.response : JSON.stringify(fr.response),
        })
      }
    }
    return
  }

  const role: 'user' | 'assistant' = content.role === 'model' ? 'assistant' : 'user'
  if (role === 'assistant' && partsHaveFunctionCall(content.parts)) {
    const text = extractText(content.parts)
    const toolCalls = extractToolCalls(content.parts)
    messages.push({
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })
    return
  }
  messages.push({ role, content: partsToChatContent(content.parts) })
}

function translateTools(groups: GeminiToolGroup[] | undefined): ChatTool[] | undefined {
  if (!groups || groups.length === 0) return undefined
  const out: ChatTool[] = []
  for (const g of groups) {
    for (const fn of g.functionDeclarations ?? []) {
      const params =
        fn.parameters && Object.keys(fn.parameters).length > 0
          ? fn.parameters
          : { type: 'object', properties: {} }
      out.push({
        type: 'function',
        function: {
          name: fn.name,
          ...(fn.description ? { description: fn.description } : {}),
          parameters: params,
        },
      })
    }
  }
  return out.length > 0 ? out : undefined
}

function translateToolChoice(
  config: GeminiToolConfig | undefined,
): 'auto' | 'required' | 'none' | undefined {
  const mode = config?.functionCallingConfig?.mode
  if (mode === 'AUTO') return 'auto'
  if (mode === 'ANY') return 'required'
  if (mode === 'NONE') return 'none'
  return undefined
}

function mapThinkingToEffort(
  cfg: GeminiThinkingConfig | undefined,
): 'low' | 'medium' | 'high' | undefined {
  if (!cfg) return undefined
  if (cfg.thinkingLevel) {
    if (cfg.thinkingLevel === 'minimal') return 'low'
    return cfg.thinkingLevel
  }
  const budget = cfg.thinkingBudget
  if (budget == null || budget <= 0) return undefined
  if (budget <= 2048) return 'low'
  if (budget <= 8192) return 'medium'
  return 'high'
}

function translateGeminiToChat(payload: GeminiPayload, model: string): ChatPayload {
  const messages: ChatMessage[] = []

  // System instruction → leading system message; Pair 1 will hoist into Anthropic system.
  if (payload.systemInstruction) {
    const parts = (payload.systemInstruction as { parts?: GeminiPart[] }).parts ?? []
    const text = extractText(parts)
    if (text) messages.push({ role: 'system', content: text })
  }

  for (const c of payload.contents as GeminiContent[]) {
    appendContentMessages(c, messages)
  }

  const genCfg = (payload.generationConfig ?? {}) as GeminiGenerationConfig
  const tools = translateTools(payload.tools as GeminiToolGroup[] | undefined)
  const toolChoice = translateToolChoice(payload.toolConfig as GeminiToolConfig | undefined)
  const effort = mapThinkingToEffort(genCfg.thinkingConfig)

  const out: Record<string, unknown> = { model, messages }
  if (genCfg.maxOutputTokens != null) out.max_tokens = genCfg.maxOutputTokens
  if (genCfg.temperature != null) out.temperature = genCfg.temperature
  if (genCfg.topP != null) out.top_p = genCfg.topP
  if (genCfg.stopSequences?.length) out.stop = genCfg.stopSequences
  if (tools) out.tools = tools
  if (toolChoice) out.tool_choice = toolChoice
  if (effort) out.reasoning_effort = effort
  if (genCfg.responseSchema) {
    out.response_format = {
      type: 'json_schema',
      json_schema: { name: 'gemini_response', strict: true, schema: genCfg.responseSchema },
    }
  } else if (genCfg.responseMimeType === 'application/json') {
    out.response_format = { type: 'json_object' }
  }
  return out as unknown as ChatPayload
}

export function translateGeminiToMessages(
  payload: GeminiPayload,
  options: TranslateGeminiToMessagesOptions,
): MessagesPayload {
  const chat = translateGeminiToChat(payload, options.model)
  return translateChatToMessages(chat, {
    fallbackMaxOutputTokens: options.fallbackMaxOutputTokens,
  })
}
