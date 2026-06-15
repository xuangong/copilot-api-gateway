/**
 * Request translator: Gemini generateContent payload → OpenAI Responses payload.
 *
 * Direction: request = client → hub. Used when the chosen model is served via
 * /v1/responses (gpt-5/o*) but the client speaks /v1beta/.../generateContent.
 *
 * Ported from copilot-gateway's `gemini-via-responses/request.ts`. Concrete
 * Responses input/tool shapes are defined locally (matching the convention
 * already used by `chat-completions-via-responses`) and the result is cast
 * to ResponsesPayload at the boundary.
 */
import type { ResponsesPayload } from '@vnext/protocols/responses'
import {
  geminiFunctionCallingIntent,
  geminiFunctionCallPart,
  geminiFunctionDeclarations,
  geminiFunctionResponsePart,
  geminiInlineDataUrl,
  geminiPartKind,
  geminiPartText,
  geminiReasoningEffort,
  geminiReasoningId,
  geminiText,
  geminiThoughtText,
  type GeminiToolCallIds,
  geminiVisibleText,
} from '../shared/gemini-via/gemini.ts'
import type { GeminiContent, GeminiPayload, GeminiGenerationConfig, GeminiPart } from '../shared/gemini-via/types.ts'

export interface TranslateGeminiToResponsesOptions {
  model: string
  fallbackMaxOutputTokens?: number
}

// ─── Local Responses target shapes (subset; cast to ResponsesPayload at end) ─

interface ResponsesInputText { type: 'input_text'; text: string }
interface ResponsesInputImage { type: 'input_image'; image_url: string; detail: 'auto' | 'low' | 'high' }
interface ResponsesOutputText { type: 'output_text'; text: string }
type ResponsesInputContent = ResponsesInputText | ResponsesInputImage | ResponsesOutputText

interface ResponsesMessageItem {
  type: 'message'
  role: 'user' | 'assistant'
  content: ResponsesInputContent[]
}
interface ResponsesFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
  status: 'completed'
}
interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
  status: 'completed'
}
interface ResponsesReasoningItem {
  type: 'reasoning'
  id: string
  summary: Array<{ type: 'summary_text'; text: string }>
}
type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem

interface ResponsesTool {
  type: 'function'
  name: string
  description?: string
  parameters: unknown
  strict: boolean
}

interface ResponsesTargetRequest {
  model: string
  stream: boolean
  input: ResponsesInputItem[]
  instructions?: string
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  text?:
    | { format: { type: 'json_object' } }
    | {
        format: {
          type: 'json_schema'
          json_schema: { name: string; schema: unknown }
        }
      }
  reasoning?: { effort: 'none' | 'low' | 'medium' | 'high'; summary?: 'detailed' }
  tools?: ResponsesTool[]
  tool_choice?:
    | 'auto'
    | 'required'
    | 'none'
    | { type: 'function'; name: string }
}

const flushPendingContent = (
  input: ResponsesInputItem[],
  pending: ResponsesInputContent[],
  role: 'user' | 'assistant',
): void => {
  if (pending.length === 0) return
  input.push({ type: 'message', role, content: [...pending] })
  pending.length = 0
}

const inlineDataToInputImage = (part: GeminiPart): ResponsesInputContent | null => {
  const imageUrl = geminiInlineDataUrl(part)
  if (imageUrl === null) return null
  return { type: 'input_image', image_url: imageUrl, detail: 'auto' }
}

const buildUserInputItems = (
  content: GeminiContent,
  turnIndex: number,
  unmatchedToolCallIds: GeminiToolCallIds,
): ResponsesInputItem[] => {
  const input: ResponsesInputItem[] = []
  const pendingContent: ResponsesInputContent[] = []

  content.parts.forEach((part, partIndex) => {
    const kind = geminiPartKind(part)
    switch (kind) {
      case null:
        return
      case 'function_response': {
        const matched = geminiFunctionResponsePart(part, unmatchedToolCallIds, turnIndex, partIndex)
        if (!matched) return
        flushPendingContent(input, pendingContent, 'user')
        input.push({
          type: 'function_call_output',
          call_id: matched.id,
          output: JSON.stringify(matched.response.response),
          status: 'completed',
        })
        return
      }
      case 'text': {
        const text = geminiPartText(part)
        if (text !== null) pendingContent.push({ type: 'input_text', text })
        return
      }
      case 'inline_data': {
        const image = inlineDataToInputImage(part)
        if (image) pendingContent.push(image)
        return
      }
      default:
        throw new Error(`Gemini → Responses translator does not accept ${kind} parts in user content.`)
    }
  })

  flushPendingContent(input, pendingContent, 'user')
  return input
}

const buildAssistantInputItems = (
  content: GeminiContent,
  turnIndex: number,
  unmatchedToolCallIds: GeminiToolCallIds,
): ResponsesInputItem[] => {
  const input: ResponsesInputItem[] = []
  const pendingContent: ResponsesInputContent[] = []

  content.parts.forEach((part, partIndex) => {
    const kind = geminiPartKind(part)
    switch (kind) {
      case null:
        return
      case 'function_call': {
        const matched = geminiFunctionCallPart(part, unmatchedToolCallIds, turnIndex, partIndex)
        if (!matched) return
        flushPendingContent(input, pendingContent, 'assistant')
        input.push({
          type: 'function_call',
          call_id: matched.id,
          name: matched.call.name,
          arguments: JSON.stringify(matched.call.args),
          status: 'completed',
        })
        return
      }
      case 'text': {
        const thoughtText = geminiThoughtText(part)
        if (thoughtText !== null) {
          flushPendingContent(input, pendingContent, 'assistant')
          input.push({
            type: 'reasoning',
            id: geminiReasoningId(turnIndex, partIndex),
            summary: [{ type: 'summary_text', text: thoughtText }],
          })
          return
        }
        const visible = geminiVisibleText(part)
        if (visible !== null) pendingContent.push({ type: 'output_text', text: visible })
        return
      }
      default:
        throw new Error(`Gemini → Responses translator does not accept ${kind} parts in model content.`)
    }
  })

  flushPendingContent(input, pendingContent, 'assistant')
  return input
}

const applyGenerationConfig = (
  request: ResponsesTargetRequest,
  generationConfig: GeminiGenerationConfig | undefined,
  fallbackMaxOutputTokens: number | undefined,
): void => {
  if (generationConfig?.maxOutputTokens !== undefined) {
    request.max_output_tokens = generationConfig.maxOutputTokens
  } else if (fallbackMaxOutputTokens !== undefined) {
    request.max_output_tokens = fallbackMaxOutputTokens
  }

  if (!generationConfig) return

  if (generationConfig.temperature !== undefined) request.temperature = generationConfig.temperature
  if (generationConfig.topP !== undefined) request.top_p = generationConfig.topP

  if (generationConfig.responseSchema !== undefined) {
    request.text = {
      format: {
        type: 'json_schema',
        json_schema: { name: 'gemini_response', schema: generationConfig.responseSchema },
      },
    }
  } else if (generationConfig.responseMimeType === 'application/json') {
    request.text = { format: { type: 'json_object' } }
  }

  const effort = geminiReasoningEffort(generationConfig.thinkingConfig)
  if (!effort) return

  request.reasoning = {
    effort,
    ...(effort !== 'none' && generationConfig.thinkingConfig?.includeThoughts === true
      ? { summary: 'detailed' as const }
      : {}),
  }
}

const buildTools = (payload: GeminiPayload): ResponsesTool[] | undefined => {
  const tools = geminiFunctionDeclarations(payload, 'any').map(declaration => ({
    type: 'function' as const,
    name: declaration.name,
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    parameters: declaration.parameters ?? { type: 'object', properties: {} },
    strict: false,
  }))
  return tools.length ? tools : undefined
}

export function translateGeminiToResponses(
  payload: GeminiPayload,
  options: TranslateGeminiToResponsesOptions,
): ResponsesPayload {
  const request: ResponsesTargetRequest = {
    model: options.model,
    stream: true,
    input: [],
  }
  const unmatchedToolCallIds: GeminiToolCallIds = {}

  const instructions = geminiText(payload.systemInstruction)
  if (instructions !== null) request.instructions = instructions

  payload.contents?.forEach((content, turnIndex) => {
    switch (content.role) {
      case 'model':
        request.input.push(...buildAssistantInputItems(content, turnIndex, unmatchedToolCallIds))
        return
      case 'user':
      case undefined:
        request.input.push(...buildUserInputItems(content, turnIndex, unmatchedToolCallIds))
        return
      default:
        throw new Error(
          `Gemini → Responses translator does not accept ${(content as { role: string }).role} content roles.`,
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
        request.tool_choice = { type: 'function', name: intent.name }
        break
    }
  }

  return request as unknown as ResponsesPayload
}
