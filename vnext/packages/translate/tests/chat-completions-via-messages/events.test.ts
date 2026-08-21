import { describe, it, expect } from 'bun:test'
import { translateMessagesToChatSSE } from '@vibe-llm/translate/chat-completions-via-messages'
import type { MessagesEvent } from '@vibe-llm/protocols/messages'

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

  describe('web search', () => {
    // Anthropic reports a server-side search as a `server_tool_use` /
    // `web_search_tool_result` block pair. Chat Completions has no counterpart
    // for either, so the sources are carried out as `url_citation` annotations
    // — otherwise a cross-protocol client gets an answer with no sources.
    const searchEvents = (results: Array<{ url: string; title?: string }>): MessagesEvent[] => [
      { type: 'message_start', message: { id: 'm_ws', type: 'message', role: 'assistant', model: 'mm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } as never },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } as never },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: results.map((r) => ({ type: 'web_search_result', encrypted_content: 'x', ...r })),
        } as never,
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } as never },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Sunny.' } as never },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } as never },
      { type: 'message_stop' },
    ]

    const annotationsOf = (chunks: Awaited<ReturnType<typeof collect<{ choices: Array<{ delta: { annotations?: Array<{ type: string; url_citation: { url: string; title?: string } }> } }> }>>>) =>
      chunks.flatMap((c) => c.choices.flatMap((ch) => ch.delta.annotations ?? []))

    it('maps web_search_tool_result sources to url_citation annotations', async () => {
      const chunks = await collect(
        translateMessagesToChatSSE(fromArray(searchEvents([
          { url: 'https://a.example/', title: 'A' },
          { url: 'https://b.example/' },
        ]))),
      )

      expect(annotationsOf(chunks)).toEqual([
        { type: 'url_citation', url_citation: { url: 'https://a.example/', title: 'A' } },
        { type: 'url_citation', url_citation: { url: 'https://b.example/' } },
      ])
      // The search block must not surface as a pending tool call: it already
      // ran server-side, so the client owes no tool result for it.
      expect(chunks.flatMap((c) => c.choices.flatMap((ch) => ch.delta.tool_calls ?? []))).toEqual([])
      const text = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')
      expect(text).toBe('Sunny.')
    })

    it('does not re-cite a URL a later search returns again', async () => {
      const twice = [
        ...searchEvents([{ url: 'https://a.example/', title: 'A' }]).slice(0, -2),
        ...searchEvents([{ url: 'https://a.example/', title: 'A' }, { url: 'https://c.example/' }]).slice(1),
      ]
      const chunks = await collect(translateMessagesToChatSSE(fromArray(twice)))
      expect(annotationsOf(chunks).map((a) => a.url_citation.url)).toEqual([
        'https://a.example/',
        'https://c.example/',
      ])
    })

    it('ignores a web_search_tool_result carrying an error instead of results', async () => {
      const evs: MessagesEvent[] = [
        { type: 'message_start', message: { id: 'm_e', type: 'message', role: 'assistant', model: 'mm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } as never },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
          } as never,
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ]
      const chunks = await collect(translateMessagesToChatSSE(fromArray(evs)))
      expect(annotationsOf(chunks)).toEqual([])
    })
  })
})
