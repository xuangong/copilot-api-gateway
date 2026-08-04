import type { MessagesInterceptor } from './types'

// Anthropic Messages envelope emitted for any context-exceeded upstream. The
// leading `prompt is too long` substring is the load-bearing part: Claude
// Code's context-exceeded detector is a case-insensitive substring match on
// `error.message`, running
//
//   error.message.toLowerCase().includes('prompt is too long')
//   error.message.toLowerCase().includes('input length and `max_tokens` exceed context limit')
//
// on whatever Error the SDK raises. `error.type` and the HTTP status are NOT
// inspected. A hit routes into the CLI's internal `prompt_too_long` category
// and triggers auto-compaction (telemetry event `tengu_compact_ptl_retry`).
// See copilot-gateway `packages/protocols/src/messages/context-window-error.ts`
// for the shipped-bundle grep that verifies this behaviour.
const PROMPT_TOO_LONG_MESSAGE =
  'prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.'

const PROMPT_TOO_LONG_BODY = new TextEncoder().encode(
  JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE },
  }),
)

// Structural + textual detector for context-exceeded error bodies coming from
// any upstream we might route through. Codes take precedence; message
// substrings are the fallback for shapes where the code was renamed or
// omitted. Coverage (all captured live or from vendor fixtures):
//
// - Copilot Responses / Chat Completions (HTTP 400):
//     {"error":{"code":"model_max_prompt_tokens_exceeded","message":"prompt token count of N exceeds the limit of M"}}
// - Codex Responses unary (HTTP 400):
//     {"error":{"code":"context_length_exceeded","message":"Your input exceeds the context window of this model. ..."}}
// - Canonical OpenAI Chat Completions:
//     {"error":{"code":"context_length_exceeded","type":"invalid_request_error","message":"This model's maximum context length is ..."}}
// - Copilot `/v1/messages` (Anthropic-shaped body carrying a Copilot-specific
//   message string):
//     {"type":"error","error":{"type":"invalid_request_error","message":"Request body is too large for model context window ..."}}
//
// Reference: copilot-gateway `translate/src/shared/messages-via/context-window-error.ts`.
// The reference project splits the concern into two files (provider-copilot
// Messages boundary interceptor for the Anthropic-shape substring, plus a
// translate-layer rewriter for the OpenAI-shape codes). vNext consolidates
// both into this Messages-interceptor layer because vNext's Messages endpoint
// can dispatch via any hub (messages / responses / chat_completions), and the
// upstream error surfaces as `upstream-error` at this same boundary regardless
// of the pair.
const codeIsContextExceeded = (code: unknown): boolean =>
  code === 'context_length_exceeded' || code === 'model_max_prompt_tokens_exceeded'

const messageIsContextExceeded = (message: unknown): boolean =>
  typeof message === 'string'
  && (message.includes('exceeds the context window of this model')
    || message.includes('maximum context length is')
    || message.includes('Request body is too large for model context window'))

interface MaybeErrorFields {
  code?: unknown
  message?: unknown
}

interface MaybeErrorBody {
  error?: MaybeErrorFields
}

const isContextExceededError = (error: MaybeErrorFields | undefined | null): boolean => {
  if (error === undefined || error === null) return false
  return codeIsContextExceeded(error.code) || messageIsContextExceeded(error.message)
}

const isContextExceededErrorObject = (parsed: unknown): boolean => {
  if (parsed === null || typeof parsed !== 'object') return false
  return isContextExceededError((parsed as MaybeErrorBody).error)
}

const isContextExceededErrorText = (text: string): boolean => {
  try {
    return isContextExceededErrorObject(JSON.parse(text))
  } catch {
    return messageIsContextExceeded(text)
  }
}

/**
 * Rewrites any context-exceeded upstream error into the canonical Anthropic
 * `prompt is too long` envelope so Claude Code's auto-compaction gate fires.
 *
 * References:
 * - https://docs.claude.com/en/docs/claude-code/common-workflows#prompt-too-long
 * - copilot-gateway `translate/src/shared/messages-via/context-window-error.ts`
 */
export const withContextWindowErrorRewritten: MessagesInterceptor = async (_inv, _ctx, run) => {
  const result = await run()
  if (result.type !== 'upstream-error') return result

  const body = new TextDecoder().decode(result.body)
  if (!isContextExceededErrorText(body)) return result

  return {
    ...result,
    type: 'upstream-error',
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: PROMPT_TOO_LONG_BODY,
  }
}
