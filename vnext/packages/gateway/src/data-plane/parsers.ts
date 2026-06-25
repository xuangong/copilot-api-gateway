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
import { ResponsesPayloadSchema, type ResponsesPayload } from '@vibe-llm/protocols/responses'
import { GeminiPayloadSchema, type GeminiPayload } from '@vibe-llm/protocols/gemini'

type ShapedError = Error & { status?: number; body?: unknown }

function shape(message: string, body: unknown): ShapedError {
  const err = new Error(message) as ShapedError
  err.status = 400
  err.body = body
  return err
}

export function parseMessagesPayload(raw: unknown): MessagesPayload {
  const r = MessagesPayloadSchema.safeParse(raw)
  if (!r.success) {
    throw shape(r.error.message, {
      type: 'error',
      error: { type: 'invalid_request_error', message: r.error.message },
    })
  }
  return r.data
}

export function parseMessagesCountTokensPayload(raw: unknown): MessagesCountTokensPayload {
  const r = MessagesCountTokensPayloadSchema.safeParse(raw)
  if (!r.success) {
    throw shape(r.error.message, {
      type: 'error',
      error: { type: 'invalid_request_error', message: r.error.message },
    })
  }
  return r.data
}

export function parseChatPayload(raw: unknown): ChatPayload {
  const r = ChatPayloadSchema.safeParse(raw)
  if (!r.success) {
    throw shape(r.error.message, {
      error: { message: r.error.message, type: 'invalid_request_error' },
    })
  }
  return r.data
}

export function parseResponsesPayload(raw: unknown): ResponsesPayload {
  const r = ResponsesPayloadSchema.safeParse(raw)
  if (!r.success) {
    throw shape(r.error.message, {
      error: { message: r.error.message, type: 'invalid_request_error' },
    })
  }
  return r.data
}

export function parseGeminiPayload(raw: unknown): GeminiPayload {
  const r = GeminiPayloadSchema.safeParse(raw)
  if (!r.success) {
    throw shape(r.error.message, {
      error: { code: 400, message: r.error.message, status: 'INVALID_ARGUMENT' },
    })
  }
  return r.data
}
