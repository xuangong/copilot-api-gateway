/**
 * Request-body readers for the four chat-flow client APIs.
 *
 * These used to validate the inbound body against the protocol schemas and
 * reject anything that didn't fit. They no longer do, and the reason is worth
 * writing down because the code now looks suspiciously empty.
 *
 * The shape of a chat request is a contract between the client and the model,
 * not between the client and us. It evolves — new content-block types, new
 * fields on old blocks, whole new modalities — and it evolves on the model
 * vendor's schedule, not ours. A gateway that validates that contract has
 * signed up to be the first thing that breaks every time the two ends agree on
 * something new: the client and the model are perfectly compatible, and the
 * proxy in the middle returns 400.
 *
 * That is not hypothetical. A Claude Code session was wedged permanently by
 * exactly this: a degenerate `tool_use` block with no `id` and no `name` got
 * into the transcript, Claude Code answered it with a `tool_result` that
 * necessarily had no `tool_use_id`, and from then on every turn replayed both
 * blocks and every turn died here with `messages.16.content: Invalid input`.
 * The upstream never saw the request. The conversation could not be continued,
 * only abandoned.
 *
 * So we read what we need in order to route, and hand the rest through
 * untouched. What we need is small and stable. Everything past it is the
 * model's business, and the model gets to be the one that says no.
 *
 * The protocol schemas still exist — they are where the TypeScript types come
 * from, and they still validate upstream *responses*, which are our own data
 * and worth checking. They just aren't pointed at inbound requests anymore.
 */
import type { MessagesPayload, MessagesCountTokensPayload } from '@vibe-llm/protocols/messages'
import type { ChatPayload } from '@vibe-llm/protocols/chat'
import { canonicalizeResponsesPayload, type CanonicalResponsesPayload } from '@vibe-llm/protocols/responses'
import type { GeminiPayload } from '@vibe-llm/protocols/gemini'

type ShapedError = Error & { status?: number; body?: unknown }

function shape(message: string, body: unknown): ShapedError {
  const err = new Error(message) as ShapedError
  err.status = 400
  err.body = body
  return err
}

/**
 * The one thing still worth refusing: a body that isn't a JSON object.
 *
 * This isn't a contract check and can't go stale — no protocol revision will
 * ever make `null`, `"hello"` or `[1,2,3]` a valid chat request. Without it the
 * first `payload.messages` downstream throws a TypeError and the caller gets an
 * opaque 500 instead of a sentence telling them what they sent.
 *
 * Each caller supplies its own error envelope because the three client APIs
 * disagree on the shape of an error body, and a client that can't parse the
 * refusal is barely better off than one that got a 500.
 */
function requireObject(raw: unknown, api: string, envelope: (message: string) => unknown): void {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return
  const message = `${api} request body must be a JSON object.`
  throw shape(message, envelope(message))
}

const anthropicEnvelope = (message: string) => ({ type: 'error', error: { type: 'invalid_request_error', message } })
const openaiEnvelope = (message: string) => ({ error: { message, type: 'invalid_request_error' } })
const geminiEnvelope = (message: string) => ({ error: { code: 400, message, status: 'INVALID_ARGUMENT' } })

export function parseMessagesPayload(raw: unknown): MessagesPayload {
  requireObject(raw, 'Messages', anthropicEnvelope)
  return raw as MessagesPayload
}

export function parseMessagesCountTokensPayload(raw: unknown): MessagesCountTokensPayload {
  requireObject(raw, 'Messages count_tokens', anthropicEnvelope)
  return raw as MessagesCountTokensPayload
}

export function parseChatPayload(raw: unknown): ChatPayload {
  requireObject(raw, 'Chat Completions', openaiEnvelope)
  return raw as ChatPayload
}

/**
 * Responses keeps its canonicalization, which is not validation: it lifts
 * `input: string` and the EasyInputMessage shorthand into the discriminated
 * `ResponsesInputItem[]` form so internal code can narrow without casting. The
 * few things it does reject — non-object body, missing `model`, an `input` that
 * is neither string nor array — are all things the gateway itself has to read
 * to route the request at all, so they can't drift out from under us.
 */
export function parseResponsesPayload(raw: unknown): CanonicalResponsesPayload {
  return canonicalizeResponsesPayload(raw)
}

export function parseGeminiPayload(raw: unknown): GeminiPayload {
  requireObject(raw, 'Gemini', geminiEnvelope)
  return raw as GeminiPayload
}
