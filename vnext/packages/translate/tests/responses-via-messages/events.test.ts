import { describe, it, expect } from 'bun:test'
import { translateMessagesToResponsesEvents } from '@vnext/translate/responses-via-messages'
import type { MessagesEvent } from '@vnext-llm/protocols/messages'

async function collect<T>(src: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of src) out.push(v)
  return out
}

async function* fromArray<T>(items: T[]): AsyncGenerator<T> { for (const it of items) yield it }

describe('responses-via-messages :: events', () => {
  it('emits response.created + response.in_progress on message_start', async () => {
    const events: MessagesEvent[] = [
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-3', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'message_stop' },
    ]
    const out = await collect(translateMessagesToResponsesEvents(fromArray(events), { responseId: 'resp_x', model: 'claude-3' }))
    expect(out[0]?.type).toBe('response.created')
    expect(out[1]?.type).toBe('response.in_progress')
    expect((out[0] as { sequence_number: number }).sequence_number).toBe(0)
    expect((out[1] as { sequence_number: number }).sequence_number).toBe(1)
    expect((out[0] as { response: { id: string; status: string } }).response.id).toBe('resp_x')
    expect((out[0] as { response: { id: string; status: string } }).response.status).toBe('in_progress')
  })

  it('text block emits output_item.added → content_part.added → output_text.delta → output_text.done → content_part.done → output_item.done', async () => {
    const events: MessagesEvent[] = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'cl', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]
    const out = await collect(translateMessagesToResponsesEvents(fromArray(events), { responseId: 'r', model: 'm' }))
    const types = out.map((e) => e.type)
    expect(types).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
    const done = out.find((e) => e.type === 'response.output_text.done') as { text: string }
    expect(done.text).toBe('Hello world')
    const completed = out.find((e) => e.type === 'response.completed') as { response: { output_text: string; status: string } }
    expect(completed.response.output_text).toBe('Hello world')
    expect(completed.response.status).toBe('completed')
  })

  it('thinking block emits reasoning_summary_part.added → text.delta → text.done → part.done → output_item.done', async () => {
    const events: MessagesEvent[] = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'cl', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ]
    const out = await collect(translateMessagesToResponsesEvents(fromArray(events), { responseId: 'r', model: 'm' }))
    const types = out.map((e) => e.type)
    expect(types).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.completed',
    ])
  })

  it('tool_use block forwards function_call_arguments deltas + done', async () => {
    const events: MessagesEvent[] = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'cl', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'doit', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '":1}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } },
      { type: 'message_stop' },
    ]
    const out = await collect(translateMessagesToResponsesEvents(fromArray(events), { responseId: 'r', model: 'm' }))
    const partials = out
      .filter((e): e is { type: 'response.function_call_arguments.delta'; delta: string; sequence_number: number; output_index: number; item_id: string } => e.type === 'response.function_call_arguments.delta')
      .map((e) => e.delta)
    expect(partials.join('')).toBe('{"x":1}')
    const argDone = out.find((e) => e.type === 'response.function_call_arguments.done') as { arguments: string }
    expect(argDone.arguments).toBe('{"x":1}')
    const itemDone = out.find((e) => e.type === 'response.output_item.done') as { item: { type: string; call_id?: string; arguments?: string; status?: string } }
    expect(itemDone.item).toMatchObject({ type: 'function_call', call_id: 'tu_1', arguments: '{"x":1}', status: 'completed' })
  })

  it('stop_reason=max_tokens maps to response.incomplete with incomplete_details', async () => {
    const events: MessagesEvent[] = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'cl', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null } },
      { type: 'message_stop' },
    ]
    const out = await collect(translateMessagesToResponsesEvents(fromArray(events), { responseId: 'r', model: 'm' }))
    const last = out[out.length - 1] as { type: string; response: { status: string; incomplete_details?: { reason: string } } }
    expect(last.type).toBe('response.incomplete')
    expect(last.response.status).toBe('incomplete')
    expect(last.response.incomplete_details).toEqual({ reason: 'max_output_tokens' })
  })

  it('passes ping events through with sequence numbers', async () => {
    const events: MessagesEvent[] = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'cl', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'ping' },
      { type: 'message_stop' },
    ]
    const out = await collect(translateMessagesToResponsesEvents(fromArray(events), { responseId: 'r', model: 'm' }))
    const ping = out.find((e) => e.type === 'ping') as { sequence_number: number } | undefined
    expect(ping).toBeDefined()
    expect(typeof ping?.sequence_number).toBe('number')
  })

  it('runs the finally block when the consumer breaks early (cancellation)', async () => {
    let upstreamReturned = false
    async function* upstream(): AsyncGenerator<MessagesEvent> {
      try {
        yield { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'cl', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }
        for (let i = 0; i < 100; i++) {
          yield { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }
        }
      } finally {
        upstreamReturned = true
      }
    }
    const it = translateMessagesToResponsesEvents(upstream(), { responseId: 'r', model: 'm' })
    let count = 0
    for await (const _ of it) {
      count++
      if (count >= 3) break
    }
    expect(upstreamReturned).toBe(true)
  })
})
