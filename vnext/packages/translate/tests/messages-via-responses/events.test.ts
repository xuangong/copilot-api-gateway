import { describe, it, expect } from 'bun:test'
import { translateResponsesEventsToMessagesEvents } from '@vnext/translate/messages-via-responses'

interface RespEv { type: string; [k: string]: unknown }

async function* fromArray<T>(items: T[]): AsyncGenerator<T> { for (const it of items) yield it }
async function collect<T>(src: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of src) out.push(v)
  return out
}

describe('messages-via-responses :: events', () => {
  it('emits message_start on response.created with id/model/usage carried through', async () => {
    const events: RespEv[] = [
      {
        type: 'response.created',
        response: { id: 'resp_123', model: 'gpt-5', usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 4 } } },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 0, input_tokens_details: { cached_tokens: 4 } } },
      },
    ]
    const out = await collect(translateResponsesEventsToMessagesEvents(fromArray(events)))
    const start = out[0] as { type: string; message?: { id: string; model: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } } }
    expect(start.type).toBe('message_start')
    expect(start.message?.id).toBe('resp_123')
    expect(start.message?.model).toBe('gpt-5')
    // input_tokens excludes cached portion (cached → cache_read_input_tokens)
    expect(start.message?.usage.input_tokens).toBe(8)
    expect(start.message?.usage.cache_read_input_tokens).toBe(4)
  })

  it('opens a tool_use block on output_item.added(function_call) and emits input_json_delta on function_call_arguments.delta', async () => {
    const events: RespEv[] = [
      { type: 'response.created', response: { id: 'r', model: 'm', usage: { input_tokens: 0 } } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'tu_1', name: 'doit' },
      },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"x":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"x":1}' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'function_call', call_id: 'tu_1', name: 'doit', arguments: '{"x":1}' }],
          usage: { input_tokens: 0, output_tokens: 1 },
        },
      },
    ]
    const out = await collect(translateResponsesEventsToMessagesEvents(fromArray(events)))
    const types = out.map((e) => (e as { type: string }).type)
    expect(types).toContain('content_block_start')
    expect(types).toContain('content_block_delta')
    const start = out.find((e) => (e as { type: string }).type === 'content_block_start') as {
      content_block: { type: string; id: string; name: string; input: Record<string, unknown> }
    }
    expect(start.content_block).toMatchObject({ type: 'tool_use', id: 'tu_1', name: 'doit' })
    const partials = out
      .filter((e): e is { type: 'content_block_delta'; index: number; delta: { type: 'input_json_delta'; partial_json: string } } =>
        (e as { type: string }).type === 'content_block_delta'
        && ((e as { delta?: { type?: string } }).delta?.type === 'input_json_delta'),
      )
      .map((e) => e.delta.partial_json)
    expect(partials.join('')).toBe('{"x":1}')
    // message_delta with stop_reason=tool_use, plus message_stop
    const msgDelta = out.find((e) => (e as { type: string }).type === 'message_delta') as {
      delta: { stop_reason: string; stop_sequence: null }
    }
    expect(msgDelta.delta.stop_reason).toBe('tool_use')
    expect((out[out.length - 1] as { type: string }).type).toBe('message_stop')
  })

  it('opens a text block lazily on output_text.delta and emits text_delta', async () => {
    const events: RespEv[] = [
      { type: 'response.created', response: { id: 'r', model: 'm', usage: { input_tokens: 0 } } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hi' },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: ' there' },
      {
        type: 'response.completed',
        response: { status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 1 } },
      },
    ]
    const out = await collect(translateResponsesEventsToMessagesEvents(fromArray(events)))
    const start = out.find((e) => (e as { type: string }).type === 'content_block_start') as {
      content_block: { type: string; text: string }
    }
    expect(start.content_block).toMatchObject({ type: 'text', text: '' })
    const deltas = out
      .filter((e): e is { type: 'content_block_delta'; delta: { type: 'text_delta'; text: string } } =>
        (e as { type: string }).type === 'content_block_delta'
        && ((e as { delta?: { type?: string } }).delta?.type === 'text_delta'),
      )
      .map((e) => e.delta.text)
    expect(deltas.join('')).toBe('Hi there')
  })

  it('opens a thinking block on reasoning_summary_text.delta and emits thinking_delta', async () => {
    const events: RespEv[] = [
      { type: 'response.created', response: { id: 'r', model: 'm', usage: { input_tokens: 0 } } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'thoughts...' },
      {
        type: 'response.completed',
        response: { status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0 } },
      },
    ]
    const out = await collect(translateResponsesEventsToMessagesEvents(fromArray(events)))
    const start = out.find((e) => (e as { type: string }).type === 'content_block_start') as {
      content_block: { type: string; thinking: string }
    }
    expect(start.content_block).toMatchObject({ type: 'thinking', thinking: '' })
    const deltas = out.filter(
      (e): e is { type: 'content_block_delta'; delta: { type: 'thinking_delta'; thinking: string } } =>
        (e as { type: string }).type === 'content_block_delta'
        && (e as { delta?: { type?: string } }).delta?.type === 'thinking_delta',
    )
    expect(deltas.length).toBe(1)
    expect(deltas[0]?.delta.thinking).toBe('thoughts...')
  })

  it('maps response.incomplete with max_output_tokens to stop_reason=max_tokens', async () => {
    const events: RespEv[] = [
      { type: 'response.created', response: { id: 'r', model: 'm', usage: { input_tokens: 0 } } },
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
          usage: { input_tokens: 0, output_tokens: 5 },
        },
      },
    ]
    const out = await collect(translateResponsesEventsToMessagesEvents(fromArray(events)))
    const md = out.find((e) => (e as { type: string }).type === 'message_delta') as {
      delta: { stop_reason: string }
    }
    expect(md.delta.stop_reason).toBe('max_tokens')
  })

  it('passes ping events through and emits an error event on response.failed', async () => {
    const events1: RespEv[] = [
      { type: 'response.created', response: { id: 'r', model: 'm', usage: { input_tokens: 0 } } },
      { type: 'ping' },
      {
        type: 'response.completed',
        response: { status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0 } },
      },
    ]
    const out1 = await collect(translateResponsesEventsToMessagesEvents(fromArray(events1)))
    expect(out1.some((e) => (e as { type: string }).type === 'ping')).toBe(true)

    const events2: RespEv[] = [
      { type: 'response.created', response: { id: 'r', model: 'm', usage: { input_tokens: 0 } } },
      { type: 'response.failed', response: { error: { message: 'boom' } } },
    ]
    const out2 = await collect(translateResponsesEventsToMessagesEvents(fromArray(events2)))
    const err = out2.find((e) => (e as { type: string }).type === 'error') as { error: { type: string; message: string } }
    expect(err.error.message).toBe('boom')
  })

  it('runs the finally block and clears state when the consumer breaks early (cancellation)', async () => {
    let upstreamReturned = false
    async function* upstream(): AsyncGenerator<RespEv> {
      try {
        yield { type: 'response.created', response: { id: 'r', model: 'm', usage: { input_tokens: 0 } } }
        for (let i = 0; i < 100; i++) {
          yield { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'x' }
        }
      } finally {
        upstreamReturned = true
      }
    }
    const it = translateResponsesEventsToMessagesEvents(upstream())
    let count = 0
    for await (const _ of it) {
      count++
      if (count >= 3) break
    }
    expect(upstreamReturned).toBe(true)
  })

  it('synthesizes a terminal error if the upstream stream ends without response.completed', async () => {
    const events: RespEv[] = [
      { type: 'response.created', response: { id: 'r', model: 'm', usage: { input_tokens: 0 } } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' },
      // no response.completed
    ]
    const out = await collect(translateResponsesEventsToMessagesEvents(fromArray(events)))
    const last = out[out.length - 1] as { type: string }
    expect(last.type).toBe('error')
  })
})
