/**
 * Streaming translator: Chat Completions SSE upstream → Responses event
 * stream.
 *
 * Direction: events = hub → client. Wraps the upstream Chat SSE chunks
 * into Responses lifecycle events.
 *
 * Conventions:
 *  - First event is a synthesized `response.created` (status `in_progress`),
 *    using the first chunk's `id`/`model`/`created`.
 *  - Text deltas open a single `response.output_item.added` (assistant
 *    message) on the first content chunk, then emit
 *    `response.output_text.delta` events for each chunk's content.
 *  - Tool call deltas open one `response.output_item.added` per chunk
 *    `index`, then emit `response.function_call_arguments.delta` for each
 *    incremental `arguments` string.
 *  - After Chat `finish_reason` and any trailing usage, an `output_item.done` is
 *    emitted for the message (if opened) and each tool call. The final
 *    `response.incomplete` carries `status: 'incomplete'` with reason
 *    `max_output_tokens` when finish was `length`; otherwise `response.completed`.
 *  - `finish` starts as `null` (no fallback) — Chat upstreams reliably set
 *    `finish_reason` on the final chunk, so the null sentinel only signals
 *    "stream ended without a finish reason," which fails the stream instead of synthesizing completion.
 */
import { chatCompletionsErrorPayloadMessage } from "@vibe-llm/protocols/chat"

interface ChatChunk {
  id?: string
  model?: string
  created?: number
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
  choices?: Array<{
    index: number
    delta: {
      role?: string
      content?: string
      refusal?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: 'stop' | 'length' | 'tool_calls' | 'function_call' | null
  }>
}

interface ToolCallState { outputIndex: number; id: string; name: string }

export async function* translateChatToResponsesEvents(
  events: AsyncIterable<unknown>,
): AsyncGenerator<unknown, void, unknown> {
  let id = ''
  let model = ''
  let created = Math.floor(Date.now() / 1000)
  let createdEmitted = false
  let messageOpened = false
  let activePart: { type: 'output_text' | 'refusal'; value: string; index: number } | undefined
  const completedParts: Array<{ type: 'output_text'; text: string; annotations: unknown[] } | { type: 'refusal'; refusal: string }> = []
  let messageItemId = ''
  let nextOutputIndex = 0
  let messageOutputIndex = -1
  const toolCalls = new Map<number, ToolCallState>() // chunk index → state
  let finish: 'stop' | 'length' | 'tool_calls' | 'function_call' | null = null

  let usage: ChatChunk['usage']
  for await (const raw of events as AsyncIterable<ChatChunk>) {
    const error = chatCompletionsErrorPayloadMessage(raw)
    if (error) throw new Error(error)
    if (raw.usage) usage = { ...usage, ...raw.usage }
    if (raw.id && !id) id = raw.id
    if (raw.model && !model) model = raw.model
    if (raw.created && !createdEmitted) created = raw.created

    if (!createdEmitted) {
      // Root parity: emit both `response.created` and `response.in_progress`
      // back-to-back, matching the OpenAI Responses lifecycle. Status is
      // `in_progress` for both — the discriminator is the event `type`.
      yield { type: 'response.created', response: { id, model, created_at: created, status: 'in_progress' } }
      yield { type: 'response.in_progress', response: { id, model, created_at: created, status: 'in_progress' } }
      createdEmitted = true
    }

    const choice = raw.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    for (const [partType, value] of [['output_text', delta.content], ['refusal', delta.refusal]] as const) {
      if (typeof value !== 'string' || (partType === 'output_text' && value.length === 0)) continue
      if (!messageOpened) {
        messageOutputIndex = nextOutputIndex++
        // Synthesize a stable per-message id so subsequent content_part / text
        // events can carry `item_id` matching the opened item.
        messageItemId = `msg_${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 14)}`
        yield {
          type: 'response.output_item.added',
          output_index: messageOutputIndex,
          item: { type: 'message', id: messageItemId, role: 'assistant', status: 'in_progress', content: [] },
        }
        messageOpened = true
      }
      if (activePart && activePart.type !== partType) {
        const part = activePart.type === 'output_text'
          ? { type: 'output_text' as const, text: activePart.value, annotations: [] }
          : { type: 'refusal' as const, refusal: activePart.value }
        yield activePart.type === 'output_text'
          ? { type: 'response.output_text.done', item_id: messageItemId, output_index: messageOutputIndex, content_index: activePart.index, text: activePart.value }
          : { type: 'response.refusal.done', item_id: messageItemId, output_index: messageOutputIndex, content_index: activePart.index, refusal: activePart.value }
        yield { type: 'response.content_part.done', item_id: messageItemId, output_index: messageOutputIndex, content_index: activePart.index, part }
        completedParts.push(part)
        activePart = undefined
      }
      if (!activePart) {
        activePart = { type: partType, value: '', index: completedParts.length }
        yield {
          type: 'response.content_part.added',
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: activePart.index,
          part: partType === 'output_text' ? { type: 'output_text', text: '', annotations: [] } : { type: 'refusal', refusal: '' },
        }
      }
      activePart.value += value
      if (value.length > 0) yield {
        type: partType === 'output_text' ? 'response.output_text.delta' : 'response.refusal.delta',
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: activePart.index,
        delta: value,
      }
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let state = toolCalls.get(tc.index)
        if (!state) {
          state = {
            outputIndex: nextOutputIndex++,
            id: tc.id ?? '',
            name: tc.function?.name ?? '',
          }
          toolCalls.set(tc.index, state)
          yield {
            type: 'response.output_item.added',
            output_index: state.outputIndex,
            item: {
              type: 'function_call',
              call_id: state.id,
              name: state.name,
              arguments: '',
            },
          }
        }
        const argDelta = tc.function?.arguments
        if (typeof argDelta === 'string' && argDelta.length > 0) {
          yield {
            type: 'response.function_call_arguments.delta',
            output_index: state.outputIndex,
            delta: argDelta,
          }
        }
      }
    }
    if (choice.finish_reason) {
      finish = choice.finish_reason
    }
  }

  if (finish === null) throw new Error("Upstream Chat Completions stream ended without a finish_reason.")

  if (messageOpened) {
    if (activePart) {
      const part = activePart.type === 'output_text'
        ? { type: 'output_text' as const, text: activePart.value, annotations: [] }
        : { type: 'refusal' as const, refusal: activePart.value }
      yield activePart.type === 'output_text'
        ? { type: 'response.output_text.done', item_id: messageItemId, output_index: messageOutputIndex, content_index: activePart.index, text: activePart.value }
        : { type: 'response.refusal.done', item_id: messageItemId, output_index: messageOutputIndex, content_index: activePart.index, refusal: activePart.value }
      yield { type: 'response.content_part.done', item_id: messageItemId, output_index: messageOutputIndex, content_index: activePart.index, part }
      completedParts.push(part)
    }
    yield {
      type: 'response.output_item.done',
      output_index: messageOutputIndex,
      item: {
        type: 'message',
        id: messageItemId,
        role: 'assistant',
        status: 'completed',
        content: completedParts,
      },
    }
  }
  for (const state of toolCalls.values()) {
    yield {
      type: 'response.output_item.done',
      output_index: state.outputIndex,
      item: { type: 'function_call', call_id: state.id, name: state.name },
    }
  }

  const status = finish === 'length' ? 'incomplete' : 'completed'
  const completed: Record<string, unknown> = {
    type: status === 'incomplete' ? 'response.incomplete' : 'response.completed',
    response: {
      id, model, created_at: created, status,
      ...(usage ? { usage: {
        ...(usage.prompt_tokens !== undefined ? { input_tokens: usage.prompt_tokens } : {}),
        ...(usage.completion_tokens !== undefined ? { output_tokens: usage.completion_tokens } : {}),
        ...(usage.total_tokens !== undefined ? { total_tokens: usage.total_tokens } : {}),
        ...(usage.prompt_tokens_details ? { input_tokens_details: usage.prompt_tokens_details } : {}),
        ...(usage.completion_tokens_details ? { output_tokens_details: usage.completion_tokens_details } : {}),
      } } : {}),
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    },
  }
  yield completed
}
