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
  let nextOutputIndex = 0
  let messageOutputIndex = -1
  const toolCalls = new Map<number, ToolCallState>() // chunk index → state
  let finish: 'stop' | 'length' | 'tool_calls' | 'function_call' | null = null

  for await (const raw of events as AsyncIterable<ChatChunk>) {
    if (raw.id && !id) id = raw.id
    if (raw.model && !model) model = raw.model
    if (raw.created && !createdEmitted) created = raw.created

    if (!createdEmitted) {
      yield { type: 'response.created', response: { id, model, created_at: created, status: 'in_progress' } }
      createdEmitted = true
    }

    const choice = raw.choices?.[0]
    if (!choice) continue
    const delta = choice.delta
    if (delta.content && delta.content.length > 0) {
      if (!messageOpened) {
        messageOutputIndex = nextOutputIndex++
        yield {
          type: 'response.output_item.added',
          output_index: messageOutputIndex,
          item: { type: 'message', role: 'assistant', content: [] },
        }
        messageOpened = true
      }
      yield {
        type: 'response.output_text.delta',
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
    yield {
      type: 'response.output_item.done',
      output_index: messageOutputIndex,
      item: { type: 'message', role: 'assistant' },
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
