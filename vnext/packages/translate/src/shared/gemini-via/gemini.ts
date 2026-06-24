/**
 * Shared helpers for gemini-via-* translator pairs (request + events).
 *
 * Ported from copilot-gateway's `shared/gemini-via/gemini.ts`. Uses local
 * structural types (./types.ts) rather than @vnext-llm/protocols/gemini, since
 * the protocols package only exports a loose zod-inferred GeminiPayload.
 */
import type {
  GeminiContent,
  GeminiFinishReason,
  GeminiFunctionCallingConfig,
  GeminiFunctionDeclaration,
  GeminiPayload,
  GeminiPart,
  GeminiResult,
  GeminiThinkingConfig,
  GeminiUsageMetadata,
} from './types.ts'
import { TranslatorValidationError } from '../../errors.ts'

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type GeminiToolCallIds = Record<string, string[]>

export type GeminiFunctionCall = NonNullable<GeminiPart['functionCall']>
export type GeminiFunctionResponse = NonNullable<GeminiPart['functionResponse']>

export type GeminiFunctionCallingIntent =
  | { type: 'none' }
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'named'; name: string }

export interface GeminiFunctionCallPart {
  call: GeminiFunctionCall
  id: string
}

export interface GeminiFunctionResponsePart {
  response: GeminiFunctionResponse
  id: string
}

const GEMINI_SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const

export type GeminiSupportedImageMimeType = (typeof GEMINI_SUPPORTED_IMAGE_MIME_TYPES)[number]

export const geminiToolCallId = (turnIndex: number, partIndex: number): string =>
  `gemini_call_${turnIndex}_${partIndex}`

export const geminiReasoningId = (turnIndex: number, partIndex: number): string =>
  `gemini_reasoning_${turnIndex}_${partIndex}`

export type GeminiPartKind =
  | 'text'
  | 'inline_data'
  | 'function_call'
  | 'function_response'
  | 'file_data'
  | 'executable_code'
  | 'code_execution_result'

type GeminiPartDataField = keyof Omit<GeminiPart, 'thought' | 'thoughtSignature'>

const GEMINI_PART_FIELD_TO_KIND: Record<GeminiPartDataField, GeminiPartKind> = {
  text: 'text',
  inlineData: 'inline_data',
  functionCall: 'function_call',
  functionResponse: 'function_response',
  fileData: 'file_data',
  executableCode: 'executable_code',
  codeExecutionResult: 'code_execution_result',
}

const GEMINI_PART_DATA_FIELDS = Object.keys(GEMINI_PART_FIELD_TO_KIND) as GeminiPartDataField[]

export const geminiPartKind = (part: GeminiPart): GeminiPartKind | null => {
  const presentFields = GEMINI_PART_DATA_FIELDS.filter(field => part[field] !== undefined)
  if (presentFields.length === 1) return GEMINI_PART_FIELD_TO_KIND[presentFields[0]!]
  if (presentFields.length > 1) {
    throw new TranslatorValidationError(`Gemini part sets conflicting content fields: ${presentFields.join(', ')}.`, 'contents.parts')
  }
  if (part.thoughtSignature !== undefined) return null
  const keys = Object.keys(part)
  throw new TranslatorValidationError(
    `Gemini part has no recognized content. Keys present: ${keys.length ? keys.join(', ') : '(none)'}.`,
    'contents.parts',
  )
}

export const geminiPartText = (part: GeminiPart): string | null =>
  typeof part.text === 'string' ? part.text : null

export const geminiThoughtText = (part: GeminiPart): string | null =>
  part.thought === true && typeof part.text === 'string' ? part.text : null

export const geminiVisibleText = (part: GeminiPart): string | null =>
  part.thought === true ? null : geminiPartText(part)

export const geminiText = (content?: GeminiContent): string | null => {
  const texts = content?.parts.map(geminiPartText).filter((text): text is string => text !== null)
  return texts?.length ? texts.join('\n\n') : null
}

export const geminiInlineData = (
  part: GeminiPart,
): { mimeType: GeminiSupportedImageMimeType; data: string } | null => {
  const inlineData = part.inlineData
  if (!inlineData) return null
  if (!GEMINI_SUPPORTED_IMAGE_MIME_TYPES.includes(inlineData.mimeType as GeminiSupportedImageMimeType))
    return null

  return {
    mimeType: inlineData.mimeType as GeminiSupportedImageMimeType,
    data: inlineData.data,
  }
}

export const geminiInlineDataUrl = (part: GeminiPart): string | null => {
  const inlineData = geminiInlineData(part)
  return inlineData ? `data:${inlineData.mimeType};base64,${inlineData.data}` : null
}

export const geminiFunctionCallPart = (
  part: GeminiPart,
  ids: GeminiToolCallIds,
  turnIndex: number,
  partIndex: number,
): GeminiFunctionCallPart | null => {
  const call = part.functionCall
  if (!call) return null

  const id = call.id ?? geminiToolCallId(turnIndex, partIndex)
  const bucket = (ids[call.name] ??= [])
  bucket.push(id)

  return { call, id }
}

export const geminiFunctionResponsePart = (
  part: GeminiPart,
  ids: GeminiToolCallIds,
  turnIndex: number,
  partIndex: number,
  remove: 'first' | 'last' = 'first',
): GeminiFunctionResponsePart | null => {
  const response = part.functionResponse
  if (!response) return null

  const unmatched = ids[response.name]
  const id = response.id ?? geminiToolCallId(turnIndex, partIndex)
  if (response.id !== undefined) {
    const index =
      remove === 'first' ? unmatched?.indexOf(response.id) ?? -1 : unmatched?.lastIndexOf(response.id) ?? -1
    if (index >= 0) unmatched?.splice(index, 1)
    return { response, id }
  }

  return { response, id: unmatched?.shift() ?? id }
}

export const geminiThinkingLevelEffort = (
  thinkingConfig?: GeminiThinkingConfig,
): 'low' | 'medium' | 'high' | undefined => {
  switch (thinkingConfig?.thinkingLevel) {
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    default:
      return undefined
  }
}

export const geminiReasoningEffort = (
  thinkingConfig?: GeminiThinkingConfig,
): 'none' | 'low' | 'medium' | 'high' | null => {
  if (!thinkingConfig) return null

  if (thinkingConfig.thinkingBudget !== undefined) {
    if (thinkingConfig.thinkingBudget === 0) return 'none'
    if (thinkingConfig.thinkingBudget < 0) return null
    if (thinkingConfig.thinkingBudget <= 2048) return 'low'
    if (thinkingConfig.thinkingBudget <= 8192) return 'medium'
    return 'high'
  }

  return geminiThinkingLevelEffort(thinkingConfig) ?? null
}

export const geminiFunctionDeclarations = (
  payload: GeminiPayload,
  allowedNameMode: 'any' | 'all' | 'none',
): GeminiFunctionDeclaration[] => {
  const config = payload.toolConfig?.functionCallingConfig
  const allowedFunctionNames = config?.allowedFunctionNames
  const allowedNames =
    allowedFunctionNames?.length &&
    (allowedNameMode === 'all' || (allowedNameMode === 'any' && config?.mode === 'ANY'))
      ? new Set(allowedFunctionNames)
      : null

  return (
    payload.tools?.flatMap(
      toolGroup =>
        toolGroup.functionDeclarations?.filter(declaration => allowedNames?.has(declaration.name) ?? true) ??
        [],
    ) ?? []
  )
}

const geminiSingleAllowedFunctionName = (config?: GeminiFunctionCallingConfig): string | undefined =>
  config?.allowedFunctionNames?.length === 1 ? config.allowedFunctionNames[0] : undefined

export const geminiFunctionCallingIntent = (
  config?: GeminiFunctionCallingConfig,
): GeminiFunctionCallingIntent | undefined => {
  switch (config?.mode) {
    case 'NONE':
      return { type: 'none' }
    case 'AUTO':
    case 'VALIDATED':
      return { type: 'auto' }
    case 'ANY': {
      const name = geminiSingleAllowedFunctionName(config)
      return name !== undefined ? { type: 'named', name } : { type: 'any' }
    }
    default:
      return undefined
  }
}

export interface GeminiThoughtSignatureState {
  pendingThoughtSignature?: string
}

export const appendGeminiThoughtSignature = (
  state: GeminiThoughtSignatureState,
  signature: string,
): void => {
  state.pendingThoughtSignature = `${state.pendingThoughtSignature ?? ''}${signature}`
}

export const signGeminiPart = (state: GeminiThoughtSignatureState, part: GeminiPart): GeminiPart => {
  if (state.pendingThoughtSignature === undefined) return part

  const signedPart = {
    ...part,
    thoughtSignature: state.pendingThoughtSignature,
  }
  state.pendingThoughtSignature = undefined
  return signedPart
}

export const flushGeminiThoughtSignature = (state: GeminiThoughtSignatureState): GeminiPart[] =>
  state.pendingThoughtSignature === undefined ? [] : [signGeminiPart(state, { text: '' })]

export const parseStrictJsonObject = (json: string, subject: string): Record<string, unknown> => {
  if (!json) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(json) as unknown
  } catch (error) {
    throw new Error(`Upstream ${subject} was not valid JSON.`, { cause: error })
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`Upstream ${subject} must be a JSON object.`)
  }

  return parsed
}

export const geminiCandidateEvent = (
  parts: GeminiPart[],
  finishReason?: GeminiFinishReason,
  usageMetadata?: GeminiUsageMetadata,
): GeminiResult => ({
  candidates: [
    {
      index: 0,
      content: { role: 'model', parts },
      ...(finishReason !== undefined ? { finishReason } : {}),
    },
  ],
  ...(usageMetadata !== undefined ? { usageMetadata } : {}),
})
