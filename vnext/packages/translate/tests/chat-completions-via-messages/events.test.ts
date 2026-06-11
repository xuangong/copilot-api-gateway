import { describe, it, expect } from 'bun:test'
import { translateMessagesToChatSSE } from '@vnext/translate/chat-completions-via-messages'
import type { MessagesEvent } from '@vnext/protocols/messages'

async function collect<T>(src: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of src) out.push(v)
  return out
}

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const it of items) yield it
}

describe('chat-completions-via-messages :: events', () => {
  it('emits role-only initial chunk on message_start with usage carry-over', async () => {
    const evs: MessagesEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-3-5',
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } as never,
        },
      },
      { type: 'message_stop' },
    ]
    const chunks = await collect(translateMessagesToChatSSE(fromArray(evs)))
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks[0]?.id).toBe('msg_1')
    expect(chunks[0]?.model).toBe('claude-3-5')
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: 'assistant' })
  })

  it('translates text deltas into Chat content deltas', async () => {
    const evs: MessagesEvent[] = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'mm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } as never } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } as never },
      { type: 'message_stop' },
    ]
    const chunks = await collect(translateMessagesToChatSSE(fromArray(evs)))
    const contents = chunks.flatMap((c) => c.choices.map((ch) => ch.delta.content).filter((s): s is string => !!s))
    expect(contents).toEqual(['Hello', ' world'])
    const finish = chunks.find((c) => c.choices[0]?.finish_reason)
    expect(finish?.choices[0]?.finish_reason).toBe('stop')
  })

  it('translates tool_use start + input_json_delta into Chat tool_calls deltas', async () => {
    const evs: MessagesEvent[] = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'mm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } as never } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'doit' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '":1}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]
    const chunks = await collect(translateMessagesToChatSSE(fromArray(evs)))
    const tcDeltas = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
    // First tool_call delta: id + name + empty arguments
    expect(tcDeltas[0]).toMatchObject({ index: 0, id: 'tu_1', type: 'function', function: { name: 'doit', arguments: '' } })
    // Subsequent tool_call deltas: only function.arguments fragments
    expect(tcDeltas[1]?.function?.arguments).toBe('{"a')
    expect(tcDeltas[2]?.function?.arguments).toBe('":1}')
    const finish = chunks.find((c) => c.choices[0]?.finish_reason)
    expect(finish?.choices[0]?.finish_reason).toBe('tool_calls')
  })

  it('maps stop_reason → finish_reason for end_turn/max_tokens/tool_use/refusal', async () => {
    const cases: Array<[string, 'stop' | 'length' | 'tool_calls']> = [
      ['end_turn', 'stop'],
      ['max_tokens', 'length'],
      ['tool_use', 'tool_calls'],
      ['refusal', 'stop'],
    ]
    for (const [reason, finish] of cases) {
      const evs: MessagesEvent[] = [
        { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'mm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } as never } },
        { type: 'message_delta', delta: { stop_reason: reason } },
        { type: 'message_stop' },
      ]
      const chunks = await collect(translateMessagesToChatSSE(fromArray(evs)))
      const f = chunks.find((c) => c.choices[0]?.finish_reason)
      expect(f?.choices[0]?.finish_reason).toBe(finish)
    }
  })

  it('emits a final usage chunk when message_delta carries usage.output_tokens', async () => {
    const evs: MessagesEvent[] = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'mm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3 } as never } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } as never },
      { type: 'message_stop' },
    ]
    const chunks = await collect(translateMessagesToChatSSE(fromArray(evs)))
    const usageChunk = chunks.find((c) => c.usage)
    expect(usageChunk).toBeDefined()
    expect(usageChunk?.usage).toMatchObject({
      prompt_tokens: 13,
      completion_tokens: 7,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 3 },
    })
  })

  it('runs the finally block when the consumer breaks early (cancellation)', async () => {
    let upstreamReturned = false
    async function* upstream(): AsyncGenerator<MessagesEvent> {
      try {
        yield { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'mm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } as never } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        // Send many deltas; consumer should break before exhausting.
        for (let i = 0; i < 100; i++) {
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }
        }
      } finally {
        upstreamReturned = true
      }
    }
    const it = translateMessagesToChatSSE(upstream())
    let count = 0
    for await (const _ of it) {
      count++
      if (count >= 3) break
    }
    expect(upstreamReturned).toBe(true)
    expect(count).toBe(3)
  })

  it('ignores ping events', async () => {
    const evs: MessagesEvent[] = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'mm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } as never } },
      { type: 'ping' },
      { type: 'message_stop' },
    ]
    const chunks = await collect(translateMessagesToChatSSE(fromArray(evs)))
    // role chunk only
    expect(chunks.filter((c) => c.choices.length > 0).length).toBe(1)
  })
})
