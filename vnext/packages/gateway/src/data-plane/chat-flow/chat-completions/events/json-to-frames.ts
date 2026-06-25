// vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/events/json-to-frames.ts
/**
 * Bridges a non-streaming upstream chat-completions JSON body into the same
 * `ProtocolFrame<ChatCompletionsStreamEvent>` async stream that the SSE parser
 * produces, so the downstream pipeline (interceptors → reassemble / SSE
 * encoding) is uniform regardless of whether the upstream chose JSON or SSE.
 *
 * Shape contract: the input is an OpenAI `chat.completion` envelope
 * (`{ id, object: 'chat.completion', created, model, choices: [...], usage? }`).
 * We emit ONE `chat.completion.chunk` event per choice whose `delta` mirrors
 * the original `message` (role + content + tool_calls), preserve `finish_reason`,
 * and fold `usage` into the same chunk. A trailing `doneFrame()` matches the
 * `[DONE]` terminal that SSE clients expect — `reassemble` short-circuits on
 * it, and `to-sse` renders it as `data: [DONE]`.
 *
 * Why a single chunk (not delta-by-delta): the legacy `dispatch()` non-stream
 * path called `translator.translateBody(json)` directly; we'd be re-tokenising
 * an already-coalesced body just to re-coalesce it. Single chunk = identical
 * reassembled output, fewer allocations, and the SSE writer never opens this
 * branch (serve.ts only takes JSON path when `wantsStream=false`).
 */
import { doneFrame, eventFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ChatCompletionsStreamEvent, ChatCompletionsDelta } from '@vibe-llm/protocols/chat'

// The wire shape for a non-streaming chat-completions body. We narrow only the
// fields we touch — everything else passes through via index signatures so
// vendor padding (content_filter_results, prompt_filter_results, service_tier,
// copilot_usage, message.padding, etc.) survives the SSE-equivalent rebuild
// and lands on the synthesized event for reassemble.ts → captureExtras to
// pick up.
interface ChatCompletionsBodyChoice {
  index: number
  message: {
    role?: string
    content?: string | null
    tool_calls?: Array<{
      id?: string
      type?: 'function'
      function?: { name?: string; arguments?: string }
    }>
    reasoning_text?: string | null
    reasoning_opaque?: string | null
    [k: string]: unknown
  }
  finish_reason?: string | null
  [k: string]: unknown
}

export interface ChatCompletionsJsonBody {
  id?: string
  object?: string
  created?: number
  model?: string
  choices: ChatCompletionsBodyChoice[]
  usage?: ChatCompletionsStreamEvent['usage']
  [k: string]: unknown
}

// Known per-scope keys consumed by the typed synthesizer below. Anything not
// in these sets is vendor padding and must be copied onto the synthesized
// chunk/choice/delta so the downstream reassembler captures it.
const KNOWN_BODY_KEYS = new Set(['id', 'object', 'created', 'model', 'choices', 'usage'])
const KNOWN_BODY_CHOICE_KEYS = new Set(['index', 'message', 'finish_reason'])
const KNOWN_BODY_MESSAGE_KEYS = new Set([
  'role', 'content', 'tool_calls', 'reasoning_text', 'reasoning_opaque', 'reasoning_items',
])

const pickExtras = (source: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(source)) {
    if (known.has(k)) continue
    if (v === undefined) continue
    out[k] = v
  }
  return out
}

const messageToDelta = (
  message: ChatCompletionsBodyChoice['message'],
  index: number,
): ChatCompletionsDelta => {
  const delta: ChatCompletionsDelta = {}
  if (typeof message.role === 'string') delta.role = message.role
  if (message.content !== undefined && message.content !== null) delta.content = message.content
  if (Array.isArray(message.tool_calls)) {
    delta.tool_calls = message.tool_calls.map((tc, i) => ({
      // Indices preserve the order so reassemble's Map keying lines up.
      index: i,
      ...(tc.id !== undefined && { id: tc.id }),
      type: 'function' as const,
      ...(tc.function && {
        function: {
          ...(tc.function.name !== undefined && { name: tc.function.name }),
          ...(tc.function.arguments !== undefined && { arguments: tc.function.arguments }),
        },
      }),
    }))
  }
  if (typeof message.reasoning_text === 'string') delta.reasoning_text = message.reasoning_text
  if (typeof message.reasoning_opaque === 'string') delta.reasoning_opaque = message.reasoning_opaque
  // Indices are intentionally derived from `index` upstream to match
  // ChatCompletionsChoiceStreaming.index; `i` is kept local to tool_calls only.
  void index
  return delta
}

export const synthesizeChatCompletionsFramesFromJson = async function* (
  body: ChatCompletionsJsonBody,
): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
  const id = body.id ?? ''
  const model = body.model ?? ''
  const created = body.created ?? Math.floor(Date.now() / 1000)
  const choices = body.choices.map((c) => {
    const delta = messageToDelta(c.message, c.index)
    // Copy any vendor padding on `message` (e.g. message.padding) into the
    // delta so reassemble's KNOWN_DELTA_KEYS capture pulls it into messageExtras.
    Object.assign(delta as Record<string, unknown>, pickExtras(c.message as Record<string, unknown>, KNOWN_BODY_MESSAGE_KEYS))
    return {
      index: c.index,
      delta,
      // `finish_reason` on a stream chunk uses the same union as a body; null is
      // valid (mid-stream). We propagate whatever upstream sent — `stop` for the
      // happy path, `length`/`tool_calls`/etc. for the rest.
      finish_reason: (c.finish_reason ?? 'stop') as 'stop' | 'length' | 'tool_calls' | 'content_filter' | null,
      // Per-choice padding (content_filter_results, etc.) lifted onto the chunk's
      // choice entry so KNOWN_CHOICE_KEYS capture flows it into choiceExtras.
      ...pickExtras(c as unknown as Record<string, unknown>, KNOWN_BODY_CHOICE_KEYS),
    }
  })
  const event: ChatCompletionsStreamEvent = {
    id,
    // Tag synthesized event so the downstream SSE encoder sees a chunk-shape
    // discriminator (`chat.completion.chunk`). The upstream's original
    // `chat.completion` is conveyed out-of-band via `__upstream_object` so
    // reassemble can echo it on the final non-streaming envelope (root parity).
    object: 'chat.completion.chunk',
    ...(body.object === 'chat.completion' && { __upstream_object: 'chat.completion' }),
    created,
    model,
    choices,
    ...(body.usage && { usage: body.usage }),
    // Top-level padding (prompt_filter_results, service_tier, copilot_usage,
    // system_fingerprint, etc.) lifted onto the synthesized event so
    // KNOWN_CHUNK_KEYS capture in reassemble picks them up as chunkExtras.
    ...pickExtras(body as unknown as Record<string, unknown>, KNOWN_BODY_KEYS),
  } as ChatCompletionsStreamEvent
  yield eventFrame(event)
  yield doneFrame()
}
