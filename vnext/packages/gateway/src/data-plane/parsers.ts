/**
 * Request-body parsers for the four chat-flow client APIs.
 *
 * These are tiny Zod-validate wrappers that mirror the legacy
 * `*-in.ts` adapter `.parse` methods. They throw an `Error` with
 * `status` + `body` properties; the dispatcher in routes.ts surfaces
 * those via the source-specific `errorWrap`.
 *
 * Kept here (rather than inside @vibe-llm/translate) because parsing is
 * request validation, not translation — the pairwise translators
 * operate on already-validated payloads.
 */
import {
  MessagesPayloadSchema,
  MessagesCountTokensPayloadSchema,
  type MessagesPayload,
  type MessagesCountTokensPayload,
} from '@vibe-llm/protocols/messages'
import { ChatPayloadSchema, type ChatPayload } from '@vibe-llm/protocols/chat'
import { ResponsesPayloadSchema, canonicalizeResponsesPayload, type CanonicalResponsesPayload } from '@vibe-llm/protocols/responses'
import { GeminiPayloadSchema, type GeminiPayload } from '@vibe-llm/protocols/gemini'

type ShapedError = Error & { status?: number; body?: unknown }

/**
 * Zod's `error.message` is a raw JSON issue dump that names the failing path
 * but never the value that failed — a client seeing `messages.1.role:
 * invalid_union` cannot tell which role it sent. Echo the received value for
 * enum-ish leaves only (role/type/status), never for content, so no prompt
 * text reaches the error body or the logs.
 */
const ECHOABLE_LEAVES = new Set(['role', 'type', 'status'])

function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let cur = raw
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<PropertyKey, unknown>)[key]
  }
  return cur
}

function describeIssues(err: { issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }> }, raw: unknown): string {
  const lines = err.issues.map((issue) => {
    const path = issue.path.join('.')
    const leaf = issue.path[issue.path.length - 1]
    const received = typeof leaf === 'string' && ECHOABLE_LEAVES.has(leaf) ? valueAt(raw, issue.path) : undefined
    const suffix = typeof received === 'string' && received.length <= 64 ? ` (received '${received}')` : ''
    return `${path || '<root>'}: ${issue.message}${suffix}`
  })
  return lines.join('; ')
}

function shape(message: string, body: unknown): ShapedError {
  const err = new Error(message) as ShapedError
  err.status = 400
  err.body = body
  return err
}

export function parseMessagesPayload(raw: unknown): MessagesPayload {
  const r = MessagesPayloadSchema.safeParse(raw)
  if (!r.success) {
    const message = describeIssues(r.error, raw)
    throw shape(message, {
      type: 'error',
      error: { type: 'invalid_request_error', message },
    })
  }
  return r.data
}

export function parseMessagesCountTokensPayload(raw: unknown): MessagesCountTokensPayload {
  const r = MessagesCountTokensPayloadSchema.safeParse(raw)
  if (!r.success) {
    const message = describeIssues(r.error, raw)
    throw shape(message, {
      type: 'error',
      error: { type: 'invalid_request_error', message },
    })
  }
  return r.data
}

export function parseChatPayload(raw: unknown): ChatPayload {
  const r = ChatPayloadSchema.safeParse(raw)
  if (!r.success) {
    const message = describeIssues(r.error, raw)
    throw shape(message, {
      error: { message: message, type: 'invalid_request_error' },
    })
  }
  return r.data
}

export function parseResponsesPayload(raw: unknown): CanonicalResponsesPayload {
  const r = ResponsesPayloadSchema.safeParse(raw)
  if (!r.success) {
    const message = describeIssues(r.error, raw)
    throw shape(message, {
      error: { message: message, type: 'invalid_request_error' },
    })
  }
  // Post-schema canonicalize: lift `input: string` and EasyInputMessage
  // shorthand into the discriminated `ResponsesInputItem[]` shape so
  // internal code narrows without cast. Throws a shaped 400 when input is
  // structurally invalid.
  return canonicalizeResponsesPayload(r.data)
}

export function parseGeminiPayload(raw: unknown): GeminiPayload {
  const r = GeminiPayloadSchema.safeParse(raw)
  if (!r.success) {
    const message = describeIssues(r.error, raw)
    throw shape(message, {
      error: { code: 400, message, status: 'INVALID_ARGUMENT' },
    })
  }
  return r.data
}
