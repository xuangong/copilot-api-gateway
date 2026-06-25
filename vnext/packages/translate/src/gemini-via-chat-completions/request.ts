/**
 * Request translator: Gemini generateContent payload → OpenAI Chat Completions payload.
 *
 * Direction: request = client → hub. Used when the chosen model is served via
 * /v1/chat/completions but the client speaks /v1beta/.../generateContent.
 *
 * Ported from copilot-gateway's `gemini-via-chat-completions/request.ts`.
 * vNext defines concrete Chat target shapes locally and casts to ChatPayload
 * at the boundary (matching the convention in chat-completions-via-responses
 * and gemini-via-responses). `reasoning_text` / `reasoning_opaque` are
 * tolerated by the loose ChatPayload schema.
 */
import type { ChatPayload } from '@vibe-llm/protocols/chat'
import {
  geminiFunctionCallingIntent,
  geminiFunctionCallPart,
  geminiFunctionDeclarations,
  geminiFunctionResponsePart,
  geminiInlineDataUrl,
  geminiPartKind,
  geminiPartText,
  geminiReasoningEffort,
  geminiText,
  geminiThoughtText,
  type GeminiToolCallIds,
  geminiVisibleText,
} from '../shared/gemini-via/gemini.ts'
import type { GeminiContent, GeminiPayload, GeminiGenerationConfig, GeminiPart } from '../shared/gemini-via/types.ts'
import { TranslatorValidationError } from '../errors.ts'

export interface TranslateGeminiToChatOptions {
  model: string
  fallbackMaxOutputTokens?: number
}

// ─── Local Chat target shapes (subset; cast to ChatPayload at end) ──────

interface ChatTextPart { type: 'text'; text: string }
interface ChatImagePart { type: 'image_url'; image_url: { url: string } }
type ChatContentPart = ChatTextPart | ChatImagePart

interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ChatContentPart[] | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  reasoning_text?: string
  reasoning_opaque?: string
}

interface ChatTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: unknown
  }
}

type ChatToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; function: { name: string } }

interface ChatTargetRequest {
  model: string
  stream: boolean
  messages: ChatMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  n?: number
  presence_penalty?: number
  frequency_penalty?: number
  seed?: number
  response_format?:
    | { type: 'json_object' }
    | { type: 'json_schema'; json_schema: { name: string; schema: unknown } }
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high'
  tools?: ChatTool[]
  tool_choice?: ChatToolChoice
}

const appendOpaque = (current: string | null, signature?: string): string | null =>
  typeof signature === 'string' ? `${current ?? ''}${signature}` : current

const inlineDataToContentPart = (part: GeminiPart): ChatContentPart | null => {
  const url = geminiInlineDataUrl(part)
  if (url === null) return null
  return { type: 'image_url', image_url: { url } }
}

const textToContentPart = (text: string): ChatContentPart => ({ type: 'text', text })

const contentFromParts = (parts: GeminiPart[]): string | ChatContentPart[] | null => {
  const textParts = parts.map(geminiPartText).filter((text): text is string => text !== null)
  const mediaParts = parts
    .map(inlineDataToContentPart)
    .filter((part): part is ChatContentPart => part !== null)

  if (!textParts.length && !mediaParts.length) return null
  if (!mediaParts.length) return textParts.join('\n\n')

  return parts.flatMap(part => {
    const text = geminiPartText(part)
    if (text !== null) return [textToContentPart(text)]
    const media = inlineDataToContentPart(part)
    return media ? [media] : []
  })
}

const buildAssistantMessage = (
  content: GeminiContent,
  turnIndex: number,
  unmatchedToolCallIds: GeminiToolCallIds,
): ChatMessage | null => {
  const visibleParts: GeminiPart[] = []
  const thoughtTexts: string[] = []
  const toolCalls: ChatToolCall[] = []
  let reasoningOpaque: string | null = null

  content.parts.forEach((part, partIndex) => {
    reasoningOpaque = appendOpaque(reasoningOpaque, part.thoughtSignature)

    const kind = geminiPartKind(part)
    switch (kind) {
      case null:
        return
      case 'function_call': {
        const matched = geminiFunctionCallPart(part, unmatchedToolCallIds, turnIndex, partIndex)
        if (!matched) return
        toolCalls.push({
          id: matched.id,
          type: 'function',
          function: {
            name: matched.call.name,
            arguments: JSON.stringify(matched.call.args),
          },
        })
        return
      }
      case 'text': {
        const thoughtText = geminiThoughtText(part)
        if (thoughtText !== null) {
          thoughtTexts.push(thoughtText)
          return
        }
        if (geminiVisibleText(part) !== null) visibleParts.push(part)
        return
      }
      case 'inline_data':
        visibleParts.push(part)
        return
      default:
        throw new TranslatorValidationError(`Gemini → Chat Completions translator does not accept ${kind} parts in model content.`, 'contents.parts')
    }
  })

  const message: ChatMessage = {
    role: 'assistant',
    content: contentFromParts(visibleParts),
  }

  if (toolCalls.length) message.tool_calls = toolCalls
  if (thoughtTexts.length) message.reasoning_text = thoughtTexts.join('\n\n')
  if (reasoningOpaque !== null) message.reasoning_opaque = reasoningOpaque

  const hasContent =
    message.content !== null
    || (message.tool_calls?.length ?? 0) > 0
    || message.reasoning_text !== undefined
    || message.reasoning_opaque !== undefined
  return hasContent ? message : null
}

const buildToolMessage = (
  part: GeminiPart,
  turnIndex: number,
  partIndex: number,
  unmatchedToolCallIds: GeminiToolCallIds,
): ChatMessage | null => {
  const matched = geminiFunctionResponsePart(part, unmatchedToolCallIds, turnIndex, partIndex)
  if (!matched) return null
  return {
    role: 'tool',
    tool_call_id: matched.id,
    content: JSON.stringify(matched.response.response),
  }
}

const buildUserMessages = (
  content: GeminiContent,
  turnIndex: number,
  unmatchedToolCallIds: GeminiToolCallIds,
): ChatMessage[] => {
  const messages: ChatMessage[] = []
  let pendingParts: GeminiPart[] = []

  const flushUserParts = (): void => {
    const chatContent = contentFromParts(pendingParts)
    pendingParts = []
    if (chatContent === null) return
    messages.push({ role: 'user', content: chatContent })
  }

  content.parts.forEach((part, partIndex) => {
    const kind = geminiPartKind(part)
    switch (kind) {
      case null:
        return
      case 'function_response': {
        flushUserParts()
        const tool = buildToolMessage(part, turnIndex, partIndex, unmatchedToolCallIds)
        if (tool) messages.push(tool)
        return
      }
      case 'text':
      case 'inline_data':
        pendingParts.push(part)
        return
      default:
        throw new TranslatorValidationError(`Gemini → Chat Completions translator does not accept ${kind} parts in user content.`, 'contents.parts')
    }
  })

  flushUserParts()
  return messages
}

const applyGenerationConfig = (
  request: ChatTargetRequest,
  generationConfig: GeminiGenerationConfig | undefined,
  fallbackMaxOutputTokens: number | undefined,
): void => {
  if (generationConfig?.maxOutputTokens !== undefined) {
    request.max_tokens = generationConfig.maxOutputTokens
  } else if (fallbackMaxOutputTokens !== undefined) {
    request.max_tokens = fallbackMaxOutputTokens
  }

  if (!generationConfig) return

  if (generationConfig.temperature !== undefined) request.temperature = generationConfig.temperature
  if (generationConfig.topP !== undefined) request.top_p = generationConfig.topP
  if (generationConfig.stopSequences !== undefined) request.stop = generationConfig.stopSequences
  if (generationConfig.candidateCount !== undefined) request.n = generationConfig.candidateCount
  if (generationConfig.presencePenalty !== undefined) request.presence_penalty = generationConfig.presencePenalty
  if (generationConfig.frequencyPenalty !== undefined) request.frequency_penalty = generationConfig.frequencyPenalty
  if (generationConfig.seed !== undefined) request.seed = generationConfig.seed

  if (generationConfig.responseSchema !== undefined) {
    request.response_format = {
      type: 'json_schema',
      json_schema: { name: 'gemini_response', schema: generationConfig.responseSchema },
    }
  } else if (generationConfig.responseMimeType === 'application/json') {
    request.response_format = { type: 'json_object' }
  }

  const reasoningEffort = geminiReasoningEffort(generationConfig.thinkingConfig)
  if (reasoningEffort) request.reasoning_effort = reasoningEffort
}

const buildTools = (payload: GeminiPayload): ChatTool[] | undefined => {
  const tools = geminiFunctionDeclarations(payload, 'any').map(declaration => ({
    type: 'function' as const,
    function: {
      name: declaration.name,
      ...(declaration.description !== undefined ? { description: declaration.description } : {}),
      ...(declaration.parameters !== undefined ? { parameters: declaration.parameters } : {}),
    },
  }))
  return tools.length ? tools : undefined
}

export function translateGeminiToChat(
  payload: GeminiPayload,
  options: TranslateGeminiToChatOptions,
): ChatPayload {
  const request: ChatTargetRequest = {
    model: options.model,
    stream: true,
    messages: [],
  }
  const unmatchedToolCallIds: GeminiToolCallIds = {}

  const systemText = geminiText(payload.systemInstruction)
  if (systemText !== null) {
    request.messages.push({ role: 'system', content: systemText })
  }

  payload.contents?.forEach((content, turnIndex) => {
    switch (content.role) {
      case 'model': {
        const message = buildAssistantMessage(content, turnIndex, unmatchedToolCallIds)
        if (message) request.messages.push(message)
        return
      }
      case 'user':
      case undefined:
        request.messages.push(...buildUserMessages(content, turnIndex, unmatchedToolCallIds))
        return
      default:
        throw new TranslatorValidationError(
          `Gemini → Chat Completions translator does not accept ${(content as { role: string }).role} content roles.`,
          'contents.role',
        )
    }
  })

  applyGenerationConfig(request, payload.generationConfig, options.fallbackMaxOutputTokens)

  const tools = buildTools(payload)
  if (tools) {
    request.tools = tools
    const intent = geminiFunctionCallingIntent(payload.toolConfig?.functionCallingConfig)
    switch (intent?.type) {
      case 'none':
        request.tool_choice = 'none'
        break
      case 'auto':
        request.tool_choice = 'auto'
        break
      case 'any':
        request.tool_choice = 'required'
        break
      case 'named':
        request.tool_choice = { type: 'function', function: { name: intent.name } }
        break
    }
  }

  return request as unknown as ChatPayload
}
