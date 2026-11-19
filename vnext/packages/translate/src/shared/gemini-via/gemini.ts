/**
 * Shared helpers for gemini-via-* translator pairs (request + events).
 *
 * Ported from copilot-gateway's `shared/gemini-via/gemini.ts`. Uses local
 * structural types (./types.ts) rather than @vibe-llm/protocols/gemini, since
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
  if (typeof part.thoughtSignature === "string" && (part.thought !== true || typeof part.text !== "string")) {
    throw new TranslatorValidationError("This signed Gemini Part cannot be represented by the available upstream protocols.", "contents.parts")
  }
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

export type GeminiInlineMedia =
  | { kind: 'image'; mimeType: GeminiSupportedImageMimeType; data: string; dataUrl: string }
  | { kind: 'pdf'; data: string; dataUrl: string }
  | { kind: 'audio'; data: string; format: 'wav' | 'mp3' }

export type GeminiInlineTarget = 'OpenAI Chat Completions' | 'OpenAI Responses' | 'Anthropic Messages'

const GEMINI_AUDIO_FORMATS: Record<string, 'wav' | 'mp3'> = { 'audio/wav': 'wav', 'audio/mp3': 'mp3', 'audio/mpeg': 'mp3' }

/**
 * Classify a part's inlineData for `target`; null when the part has none.
 * Media the target cannot represent throws instead of being dropped: a silently
 * missing attachment yields a confident wrong answer (reference #619).
 */
export const geminiInlineMedia = (part: GeminiPart, target: GeminiInlineTarget): GeminiInlineMedia | null => {
  const inlineData = part.inlineData
  if (!inlineData) return null
  const { mimeType, data } = inlineData
  const dataUrl = `data:${mimeType};base64,${data}`
  if (GEMINI_SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType as GeminiSupportedImageMimeType)) {
    return { kind: 'image', mimeType: mimeType as GeminiSupportedImageMimeType, data, dataUrl }
  }
  if (mimeType === 'application/pdf') return { kind: 'pdf', data, dataUrl }
  const format = GEMINI_AUDIO_FORMATS[mimeType]
  if (format !== undefined && target === 'OpenAI Chat Completions') return { kind: 'audio', data, format }
  throw new TranslatorValidationError(
    `Cannot translate Gemini generateContent inlineData MIME type '${mimeType}' to ${target}.`,
    'contents.parts',
  )
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

// Gemini's wire enum is uppercase; targets speak lowercase effort names. The
// default sentinel leaves effort unset and any other value is forwarded
// verbatim (open-string protocol values are upstream-owned).
// https://ai.google.dev/api/generate-content#ThinkingLevel
export const geminiThinkingLevelEffort = (
  thinkingConfig?: GeminiThinkingConfig,
): string | undefined => {
  switch (thinkingConfig?.thinkingLevel) {
    case 'LOW': return 'low'
    case 'MEDIUM': return 'medium'
    case 'HIGH': return 'high'
    case 'MINIMAL': return 'minimal'
    case 'THINKING_LEVEL_UNSPECIFIED': return undefined
    default: return thinkingConfig?.thinkingLevel
  }
}

export const geminiReasoningEffort = (
  thinkingConfig?: GeminiThinkingConfig,
): string | null => {
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

/**
 * True when the request asks for Google's hosted web search.
 *
 * `googleSearch` is the current spelling; `googleSearchRetrieval` is the
 * Gemini 1.5-era one. Both mean "ground this turn in web results", so both map
 * onto whatever hosted search the target protocol offers. The declared value
 * of either key is an options object we have no equivalent for (dynamic
 * retrieval thresholds and the like) — its presence is the whole signal.
 *
 * The gateway does not strip these groups any more (see the gemini
 * `strip-unsupported-tools` interceptor): every gemini request is translated,
 * so each `gemini-via-*` request translator is responsible for mapping this
 * onto its target's hosted-search shape.
 */
export const geminiWantsWebSearch = (payload: GeminiPayload): boolean =>
  payload.tools?.some(
    toolGroup => toolGroup.googleSearch !== undefined || toolGroup.googleSearchRetrieval !== undefined,
  ) ?? false

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
