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
 *  - On Chat `finish_reason`, the loop breaks; an `output_item.done` is
 *    emitted for the message (if opened) and each tool call. The final
 *    `response.completed` carries `status: 'incomplete'` with reason
 *    `max_output_tokens` when finish was `length`; otherwise `completed`.
 *  - `finish` starts as `null` (no fallback) — Chat upstreams reliably set
 *    `finish_reason` on the final chunk, so the null sentinel only signals
 *    "stream ended without a finish reason," which still maps to
 *    `completed` in the emitted lifecycle.
 */
interface ChatChunk {
  id?: string
  model?: string
  created?: number
  choices?: Array<{
    index: number
    delta: {
      role?: string
      content?: string
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
  let contentPartOpened = false
  let messageItemId = ''
  let accumulatedText = ''
  let nextOutputIndex = 0
  let messageOutputIndex = -1
  const toolCalls = new Map<number, ToolCallState>() // chunk index → state
  let finish: 'stop' | 'length' | 'tool_calls' | 'function_call' | null = null

  for await (const raw of events as AsyncIterable<ChatChunk>) {
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
    const delta = choice.delta
    if (delta.content && delta.content.length > 0) {
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
      if (!contentPartOpened) {
        yield {
          type: 'response.content_part.added',
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }
        contentPartOpened = true
      }
      accumulatedText += delta.content
      yield {
        type: 'response.output_text.delta',
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        delta: delta.content,
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
      break
    }
  }

  if (messageOpened) {
    if (contentPartOpened) {
      yield {
        type: 'response.output_text.done',
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        text: accumulatedText,
      }
      yield {
        type: 'response.content_part.done',
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: accumulatedText, annotations: [] },
      }
    }
    yield {
      type: 'response.output_item.done',
      output_index: messageOutputIndex,
      item: {
        type: 'message',
        id: messageItemId,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: accumulatedText, annotations: [] }],
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
    type: 'response.completed',
    response: {
      id, model, created_at: created, status,
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    },
  }
  yield completed
}
