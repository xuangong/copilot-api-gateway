import { describe, it, expect } from 'bun:test'
import { translateChatSSEToMessagesEvents } from '@vnext/translate/messages-via-chat-completions'
import type { MessagesEvent } from '@vnext-llm/protocols/messages'

async function collect<T>(src: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of src) out.push(v)
  return out
}

async function* fromArray<T>(items: T[]): AsyncGenerator<T> { for (const it of items) yield it }

describe('messages-via-chat-completions :: events', () => {
  it('emits message_start lazily on the first chunk with a delta', async () => {
    const chunks = [
      { id: 'chatcmpl_1', model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' } }] },
      { id: 'chatcmpl_1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
    const events = await collect(translateChatSSEToMessagesEvents(fromArray(chunks)))
    expect(events[0]?.type).toBe('message_start')
    expect((events[0] as { message: { id: string; model: string } }).message.id).toBe('chatcmpl_1')
    expect((events[0] as { message: { id: string; model: string } }).message.model).toBe('gpt-4o')
  })

  it('opens text block once on first content delta and emits text_delta', async () => {
    const chunks = [
      { id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'Hello' } }] },
      { id: 'c', choices: [{ index: 0, delta: { content: ' world' } }] },
      { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
    const events = await collect(translateChatSSEToMessagesEvents(fromArray(chunks)))
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    const text = events
      .filter((e): e is Extract<MessagesEvent, { type: 'content_block_delta' }> => e.type === 'content_block_delta')
      .map((e) => (e.delta as { text?: string }).text ?? '')
      .join('')
    expect(text).toBe('Hello world')
  })

  it('opens tool_use block on tool_calls and forwards arguments as input_json_delta', async () => {
    const chunks = [
      { id: 'c', model: 'm', choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: 'tu_1', type: 'function' as const, function: { name: 'doit', arguments: '' } }],
      } }] },
      { id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x' } }] } }] },
      { id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '":1}' } }] } }] },
      { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]
    const events = await collect(translateChatSSEToMessagesEvents(fromArray(chunks)))
    const start = events.find((e) => e.type === 'content_block_start') as Extract<MessagesEvent, { type: 'content_block_start' }>
    expect(start?.content_block).toMatchObject({ type: 'tool_use', id: 'tu_1', name: 'doit' })
    const partials = events
      .filter((e): e is Extract<MessagesEvent, { type: 'content_block_delta' }> => e.type === 'content_block_delta')
      .map((e) => (e.delta as { partial_json?: string }).partial_json ?? '')
    expect(partials.join('')).toBe('{"x":1}')
    const md = events.find((e) => e.type === 'message_delta') as Extract<MessagesEvent, { type: 'message_delta' }>
    expect(md.delta.stop_reason).toBe('tool_use')
  })

  it('reasoning_text opens a thinking block before any text', async () => {
    const chunks = [
      { id: 'c', model: 'm', choices: [{ index: 0, delta: { reasoning_text: 'pondering' } }] },
      { id: 'c', choices: [{ index: 0, delta: { content: 'answer' } }] },
      { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
    const events = await collect(translateChatSSEToMessagesEvents(fromArray(chunks)))
    const opens = events.filter((e) => e.type === 'content_block_start') as Array<Extract<MessagesEvent, { type: 'content_block_start' }>>
    expect((opens[0]?.content_block as { type?: string }).type).toBe('thinking')
    expect((opens[1]?.content_block as { type?: string }).type).toBe('text')
  })

  it('finish_reason maps to Anthropic stop_reason and surfaces output_tokens', async () => {
    const chunks = [
      { id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'x' } }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } } },
      { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
    ]
    const events = await collect(translateChatSSEToMessagesEvents(fromArray(chunks)))
    const md = events.find((e) => e.type === 'message_delta') as Extract<MessagesEvent, { type: 'message_delta' }>
    expect(md.delta.stop_reason).toBe('max_tokens')
    expect((md.usage as { output_tokens?: number; cache_read_input_tokens?: number })?.output_tokens).toBe(5)
    expect((md.usage as { output_tokens?: number; cache_read_input_tokens?: number })?.cache_read_input_tokens).toBe(3)
    const ms = events.find((e) => e.type === 'message_start') as Extract<MessagesEvent, { type: 'message_start' }>
    // input_tokens captured pre-emit defaults to 0; usage_only chunk arrives after
    expect((ms.message.usage as { input_tokens: number }).input_tokens).toBe(0)
  })

  it('synthesizes a terminal sequence when upstream stream ends without finish_reason', async () => {
    const chunks = [
      { id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'x' } }] },
    ]
    const events = await collect(translateChatSSEToMessagesEvents(fromArray(chunks)))
    const types = events.map((e) => e.type)
    expect(types[types.length - 1]).toBe('message_stop')
    expect(types).toContain('message_delta')
  })

  it('runs the finally block when the consumer breaks early (cancellation)', async () => {
    let upstreamReturned = false
    async function* upstream() {
      try {
        yield { id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'a' } }] }
        for (let i = 0; i < 100; i++) {
          yield { id: 'c', choices: [{ index: 0, delta: { content: 'x' } }] }
        }
      } finally {
        upstreamReturned = true
      }
    }
    const it = translateChatSSEToMessagesEvents(upstream())
    let count = 0
    for await (const _ of it) {
      count++
      if (count >= 3) break
    }
    expect(upstreamReturned).toBe(true)
  })
})
