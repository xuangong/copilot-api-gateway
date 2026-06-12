interface ChatChoiceDelta {
  role?: 'assistant'
  content?: string
  tool_calls?: Array<{
    index: number
    id?: string
    type?: 'function'
    function: { name?: string; arguments?: string }
  }>
}

export interface ChatSSEChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{ index: 0; delta: ChatChoiceDelta; finish_reason: 'stop' | 'length' | 'tool_calls' | null }>
}

interface ResponsesEvent {
  type: string
  response?: { id?: string; model?: string; created_at?: number; status?: string; incomplete_details?: { reason?: string } }
  delta?: string
  output_index?: number
  item?: { type?: string; call_id?: string; name?: string; arguments?: string }
}

function makeChunk(id: string, model: string, created: number, delta: ChatChoiceDelta, finish: ChatSSEChunk['choices'][number]['finish_reason'] = null): ChatSSEChunk {
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

export async function* translateResponsesToChatSSE(
  events: AsyncIterable<unknown>,
): AsyncGenerator<ChatSSEChunk, void, unknown> {
  let id = ''
  let model = ''
  let created = Math.floor(Date.now() / 1000)
  let sawToolCall = false
  let finish: ChatSSEChunk['choices'][number]['finish_reason'] = 'stop'
  let started = false

  for await (const ev of events as AsyncIterable<ResponsesEvent>) {
    if (ev.type === 'response.created') {
      id = ev.response?.id ?? id
      model = ev.response?.model ?? model
      if (ev.response?.created_at) created = ev.response.created_at
      yield makeChunk(id, model, created, { role: 'assistant' })
      started = true
      continue
    }
    if (!started) {
      // Some upstreams emit deltas without a preceding response.created; synthesize role chunk.
      yield makeChunk(id, model, created, { role: 'assistant' })
      started = true
    }
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      yield makeChunk(id, model, created, { content: ev.delta })
      continue
    }
    if (ev.type === 'response.output_item.added' && ev.item?.type === 'function_call') {
      sawToolCall = true
      yield makeChunk(id, model, created, {
        tool_calls: [{
          index: ev.output_index ?? 0,
          id: ev.item.call_id ?? '',
          type: 'function',
          function: { name: ev.item.name ?? '', arguments: ev.item.arguments ?? '' },
        }],
      })
      continue
    }
    if (ev.type === 'response.function_call_arguments.delta' && typeof ev.delta === 'string') {
      yield makeChunk(id, model, created, {
        tool_calls: [{ index: ev.output_index ?? 0, function: { arguments: ev.delta } }],
      })
      continue
    }
    if (ev.type === 'response.completed') {
      const reason = ev.response?.incomplete_details?.reason
      if (reason === 'max_output_tokens') finish = 'length'
      else if (sawToolCall) finish = 'tool_calls'
      else finish = 'stop'
      break
    }
  }

  yield makeChunk(id, model, created, {}, finish)
}
