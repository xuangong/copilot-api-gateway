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
import { doneFrame, eventFrame, type ProtocolFrame } from '@vnext-gateway/result'
import type { ChatCompletionsStreamEvent, ChatCompletionsDelta } from '@vnext-llm/protocols/chat'

// The wire shape for a non-streaming chat-completions body. We narrow only the
// fields we touch — everything else passes through via the `usage` field.
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
  }
  finish_reason?: string | null
}

export interface ChatCompletionsJsonBody {
  id?: string
  object?: string
  created?: number
  model?: string
  choices: ChatCompletionsBodyChoice[]
  usage?: ChatCompletionsStreamEvent['usage']
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
  const choices = body.choices.map((c) => ({
    index: c.index,
    delta: messageToDelta(c.message, c.index),
    // `finish_reason` on a stream chunk uses the same union as a body; null is
    // valid (mid-stream). We propagate whatever upstream sent — `stop` for the
    // happy path, `length`/`tool_calls`/etc. for the rest.
    finish_reason: (c.finish_reason ?? 'stop') as 'stop' | 'length' | 'tool_calls' | 'content_filter' | null,
  }))
  const event: ChatCompletionsStreamEvent = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices,
    ...(body.usage && { usage: body.usage }),
  }
  yield eventFrame(event)
  yield doneFrame()
}
