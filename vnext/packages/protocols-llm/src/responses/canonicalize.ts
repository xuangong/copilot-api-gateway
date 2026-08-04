import type {
  CanonicalResponsesPayload,
  ResponsesEasyInputMessage,
  ResponsesInputItem,
  ResponsesRequestPayload,
} from './index.ts'

// Wire `ResponsesRequestPayload.input` accepts a bare string and EasyInputMessage
// objects whose `type: "message"` discriminator is omitted. The gateway's
// canonical internal shape is an explicitly discriminated item array: every
// consumer past HTTP entry normalization sees `type: "message"` on every
// message so TS narrowing works without cast.
//
// Ported verbatim from copilot-gateway/packages/translate/src/canonicalize-responses-payload.ts
// (minus the TranslatorInputError dependency — errors here throw a plain Error
// with `status`/`body`, matching parsers.ts's shape convention).

export type CanonicalizeInputError = Error & {
  status?: number
  body?: unknown
  param?: string
}

function shapeError(message: string, extras: { param?: string; code?: string } = {}): CanonicalizeInputError {
  const err = new Error(message) as CanonicalizeInputError
  err.status = 400
  err.param = extras.param
  err.body = {
    error: {
      message,
      type: 'invalid_request_error',
      ...(extras.param ? { param: extras.param } : {}),
      ...(extras.code ? { code: extras.code } : {}),
    },
  }
  return err
}

const hasValidPromptCacheBreakpoint = (content: Record<string, unknown>): boolean => {
  const breakpoint = content.prompt_cache_breakpoint
  if (breakpoint === undefined || breakpoint === null) return true
  return typeof breakpoint === 'object'
    && typeof (breakpoint as Record<string, unknown>).mode === 'string'
}

const isImplicitEasyInputMessage = (
  item: unknown,
): item is ResponsesEasyInputMessage & { type?: undefined } => {
  if (typeof item !== 'object' || item === null) return false
  const message = item as Record<string, unknown>
  if (message.type !== undefined) return false
  if (
    message.role !== 'user'
    && message.role !== 'assistant'
    && message.role !== 'system'
    && message.role !== 'developer'
  ) return false
  if (message.phase !== undefined && message.phase !== null && typeof message.phase !== 'string') return false
  return typeof message.content === 'string'
    || (Array.isArray(message.content) && message.content.every(part => {
      if (typeof part !== 'object' || part === null) return false
      const content = part as Record<string, unknown>
      switch (content.type) {
        case 'input_text':
        case 'output_text':
          return typeof content.text === 'string' && hasValidPromptCacheBreakpoint(content)
        case 'input_image':
          return (typeof content.image_url === 'string' || typeof content.file_id === 'string')
            && hasValidPromptCacheBreakpoint(content)
        case 'input_file':
          return hasValidPromptCacheBreakpoint(content)
        default:
          return false
      }
    }))
}

// Lift a (schema-validated) `ResponsesRequestPayload` to canonical form. Called
// at the wire boundary after zod parsing; internal code past this point can
// assume `input: ResponsesInputItem[]` with explicit `type: 'message'`.
export function canonicalizeResponsesPayload(value: unknown): CanonicalResponsesPayload {
  if (typeof value !== 'object' || value === null) {
    throw shapeError('Responses payload must be an object.')
  }
  const payload = value as ResponsesRequestPayload
  if (typeof payload.model !== 'string' || payload.model.length === 0) {
    throw shapeError("Missing required parameter: 'model'.", { param: 'model', code: 'missing_required_parameter' })
  }
  const input: unknown = payload.input
  if (typeof input !== 'string' && !Array.isArray(input)) {
    throw shapeError('Responses input must be a string or an array.', { param: 'input' })
  }
  return {
    ...payload,
    input: typeof input === 'string'
      ? [{ type: 'message', role: 'user', content: input }]
      : input.map((item, index) => {
          if (isImplicitEasyInputMessage(item)) return { ...item, type: 'message' }
          if (typeof item !== 'object' || item === null || (item as { type?: unknown }).type === undefined) {
            throw shapeError('Untyped Responses input items require a valid role and content.', { param: `input[${index}]` })
          }
          return item as ResponsesInputItem
        }),
  }
}
