import { describe, it, expect } from 'bun:test'
import { translateResponsesEventsToMessagesEvents } from '@vibe-llm/translate/messages-via-responses'

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

  describe('hosted web search', () => {
    // Responses announces a search as a `web_search_call` output item: the
    // `added` event carries only an id, while the query and the resolved
    // sources arrive together on `done`. Anthropic splits the same thing
    // across two blocks — `server_tool_use` for the call, then
    // `web_search_tool_result` for what it found — which is exactly what the
    // dashboard's Messages stream reader already looks for.
    const searchAdded = { type: 'response.output_item.added', output_index: 1,
      item: { type: 'web_search_call', status: 'in_progress', id: 'ws_1' } }
    const searchDone = (results?: unknown) => ({
      type: 'response.output_item.done', output_index: 1,
      item: {
        type: 'web_search_call', status: 'completed', id: 'ws_1',
        action: { type: 'search', query: '北京 天气', queries: ['北京 天气'] },
        ...(results === undefined ? {} : { results }),
      },
    })
    const blocksOf = (out: unknown[]) => out
      .filter((e) => (e as { type: string }).type === 'content_block_start')
      .map((e) => (e as { content_block: Record<string, unknown> }).content_block)

    it('opens a server_tool_use block for the search and streams the query as its input', async () => {
      const out = await collect(translateResponsesEventsToMessagesEvents(fromArray([
        { type: 'response.created', response: { id: 'r', model: 'm' } },
        searchAdded,
        searchDone([{ type: 'text_result', url: 'https://a.example', title: 'A', snippet: 's' }]),
        { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2 } } },
      ] as RespEv[])))
      const call = blocksOf(out).find((b) => b.type === 'server_tool_use')
      expect(call).toEqual({ type: 'server_tool_use', id: 'ws_1', name: 'web_search', input: {} })
      // The query is only known on `done`, so it arrives as an input delta.
      const argDelta = out.find((e) => {
        const ev = e as { type: string; delta?: { type?: string } }
        return ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta'
      }) as { delta: { partial_json: string } } | undefined
      expect(JSON.parse(argDelta!.delta.partial_json)).toEqual({ query: '北京 天气' })
    })

    it('emits a web_search_tool_result block carrying the resolved sources', async () => {
      const out = await collect(translateResponsesEventsToMessagesEvents(fromArray([
        { type: 'response.created', response: { id: 'r', model: 'm' } },
        searchAdded,
        searchDone([
          { type: 'text_result', url: 'https://a.example', title: 'A', snippet: 's' },
          { type: 'text_result', url: 'https://b.example', title: 'B', snippet: 's' },
        ]),
        { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2 } } },
      ] as RespEv[])))
      const result = blocksOf(out).find((b) => b.type === 'web_search_tool_result')
      expect(result).toEqual({
        type: 'web_search_tool_result',
        tool_use_id: 'ws_1',
        // `encrypted_content` is required by the Messages schema but has no
        // Responses counterpart, so it is empty rather than fabricated.
        content: [
          { type: 'web_search_result', url: 'https://a.example', title: 'A', encrypted_content: '' },
          { type: 'web_search_result', url: 'https://b.example', title: 'B', encrypted_content: '' },
        ],
      })
    })

    it('skips the result block when upstream returned no sources', async () => {
      const out = await collect(translateResponsesEventsToMessagesEvents(fromArray([
        { type: 'response.created', response: { id: 'r', model: 'm' } },
        searchAdded,
        searchDone(undefined),
        { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2 } } },
      ] as RespEv[])))
      expect(blocksOf(out).some((b) => b.type === 'web_search_tool_result')).toBe(false)
      // The call itself is still reported, so the client can see a search ran.
      expect(blocksOf(out).some((b) => b.type === 'server_tool_use')).toBe(true)
    })

    it('keeps answer text in its own block after a search', async () => {
      const out = await collect(translateResponsesEventsToMessagesEvents(fromArray([
        { type: 'response.created', response: { id: 'r', model: 'm' } },
        searchAdded,
        searchDone([{ type: 'text_result', url: 'https://a.example', title: 'A' }]),
        { type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: '多云' },
        { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2 } } },
      ] as RespEv[])))
      expect(blocksOf(out).map((b) => b.type))
        .toEqual(['server_tool_use', 'web_search_tool_result', 'text'])
      // A server-side search is not a client tool call, so the turn still ends normally.
      const delta = out.find((e) => (e as { type: string }).type === 'message_delta') as
        { delta: { stop_reason: string } }
      expect(delta.delta.stop_reason).toBe('end_turn')
    })

    // The gateway's shim originates its own searches, so it can name the query
    // on `added` — while the search is still running — instead of making the
    // client wait for `done`. Anthropic has no slot for a late-arriving query
    // either, so it has to go out as the block's first input delta.
    it('streams the query as soon as `added` names it, without waiting for done', async () => {
      const out = await collect(translateResponsesEventsToMessagesEvents(fromArray([
        { type: 'response.created', response: { id: 'r', model: 'm' } },
        { type: 'response.output_item.added', output_index: 1, item: {
          type: 'web_search_call', status: 'in_progress', id: 'ws_1',
          action: { type: 'search', query: '北京 天气', queries: ['北京 天气'] },
        } },
      ] as RespEv[])))
      const argDelta = out.find((e) => {
        const ev = e as { type: string; delta?: { type?: string } }
        return ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta'
      }) as { delta: { partial_json: string } } | undefined
      expect(JSON.parse(argDelta!.delta.partial_json)).toEqual({ query: '北京 天气' })
    })

    it('does not restate the query when done repeats it', async () => {
      const out = await collect(translateResponsesEventsToMessagesEvents(fromArray([
        { type: 'response.created', response: { id: 'r', model: 'm' } },
        { type: 'response.output_item.added', output_index: 1, item: {
          type: 'web_search_call', status: 'in_progress', id: 'ws_1',
          action: { type: 'search', query: '北京 天气', queries: ['北京 天气'] },
        } },
        searchDone([{ type: 'text_result', url: 'https://a.example', title: 'A' }]),
        { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2 } } },
      ] as RespEv[])))
      const argDeltas = out.filter((e) => {
        const ev = e as { type: string; delta?: { type?: string } }
        return ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta'
      })
      expect(argDeltas.length).toBe(1)
    })
  })

  // Responses reports token counts only on the terminal envelope, but
  // `message_start` — where Anthropic puts `input_tokens` — is emitted from
  // `response.created`, long before they exist. Without restating them on
  // `message_delta` the client reports `0` prompt tokens for every turn.
  it('restates input_tokens on message_delta, where Responses finally reports them', async () => {
    const out = await collect(translateResponsesEventsToMessagesEvents(fromArray([
      { type: 'response.created', response: { id: 'r', model: 'm' } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hi' },
      { type: 'response.completed', response: {
        status: 'completed', output: [],
        usage: { input_tokens: 973, output_tokens: 158, input_tokens_details: { cached_tokens: 73 } },
      } },
    ] as RespEv[])))
    const delta = out.find((e) => (e as { type: string }).type === 'message_delta') as
      { usage: { input_tokens?: number; output_tokens: number; cache_read_input_tokens?: number } }
    // Same split as message_start: the cached portion is reported separately.
    expect(delta.usage.input_tokens).toBe(900)
    expect(delta.usage.output_tokens).toBe(158)
    expect(delta.usage.cache_read_input_tokens).toBe(73)
  })
})
