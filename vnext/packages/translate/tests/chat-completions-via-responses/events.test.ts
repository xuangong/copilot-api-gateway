import { describe, test, expect } from 'bun:test'
import { translateResponsesToChatSSE } from '../../src/chat-completions-via-responses/index.ts'

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

async function* feed(items: unknown[]): AsyncIterable<unknown> {
  for (const i of items) yield i
}

describe('translateResponsesToChatSSE', () => {
  test('text-only response emits assistant role + content + finish:stop', async () => {
    const events = [
      { type: 'response.created', response: { id: 'r1', model: 'gpt-x', created_at: 1 } },
      { type: 'response.output_text.delta', delta: 'hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      { type: 'response.completed', response: { id: 'r1', status: 'completed' } },
    ]
    const chunks = await collect(translateResponsesToChatSSE(feed(events))) as Array<{
      choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>
      id: string; model: string
    }>
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' })
    expect(chunks[0].id).toBe('r1')
    expect(chunks[0].model).toBe('gpt-x')
    expect(chunks[1].choices[0].delta).toEqual({ content: 'hel' })
    expect(chunks[2].choices[0].delta).toEqual({ content: 'lo' })
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('stop')
  })

  test('function_call streams id+name first, then incremental arguments, finish:tool_calls', async () => {
    const events = [
      { type: 'response.created', response: { id: 'r2', model: 'm', created_at: 2 } },
      { type: 'response.output_item.added', output_index: 0,
        item: { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"x":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' },
      { type: 'response.completed', response: { id: 'r2', status: 'completed' } },
    ]
    const chunks = await collect(translateResponsesToChatSSE(feed(events))) as Array<{
      choices: Array<{ delta: { tool_calls?: Array<{ index: number; id?: string; type?: string; function: { name?: string; arguments?: string } }> }; finish_reason: string | null }>
    }>
    const added = chunks.find((c) => c.choices[0].delta.tool_calls?.[0]?.id === 'call_a')!
    expect(added.choices[0].delta.tool_calls![0]).toEqual({
      index: 0, id: 'call_a', type: 'function', function: { name: 'f', arguments: '' },
    })
    const argDeltas = chunks.filter((c) =>
      c.choices[0].delta.tool_calls && c.choices[0].delta.tool_calls[0].id === undefined,
    )
    expect(argDeltas[0].choices[0].delta.tool_calls![0]).toEqual({ index: 0, function: { arguments: '{"x":' } })
    expect(argDeltas[1].choices[0].delta.tool_calls![0]).toEqual({ index: 0, function: { arguments: '1}' } })
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('tool_calls')
  })

  test('length stop_reason → finish_reason:length', async () => {
    const events = [
      { type: 'response.created', response: { id: 'r', model: 'm', created_at: 3 } },
      { type: 'response.output_text.delta', delta: 'x' },
      { type: 'response.completed', response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
    ]
    const chunks = await collect(translateResponsesToChatSSE(feed(events))) as Array<{ choices: Array<{ finish_reason: string | null }> }>
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('length')
  })

  test('cancellation: consumer breaking early runs upstream finally', async () => {
    let upstreamClosed = false
    async function* upstream(): AsyncGenerator<unknown> {
      try {
        yield { type: 'response.created', response: { id: 'r', model: 'm', created_at: 1 } }
        for (let i = 0; i < 100; i++) {
          yield { type: 'response.output_text.delta', delta: 'x' }
        }
      } finally {
        upstreamClosed = true
      }
    }
    const it = translateResponsesToChatSSE(upstream())
    let count = 0
    for await (const _ of it) {
      count++
      if (count >= 3) break
    }
    expect(upstreamClosed).toBe(true)
    expect(count).toBe(3)
  })

  describe('usage', () => {
    // Responses reports tokens once, on the terminal envelope. Without this
    // bridge a Chat Completions client sees no usage at all (the dashboard
    // playground renders "— 入 / — 出").
    const completed = (usage: unknown) => [
      { type: 'response.created', response: { id: 'r_u', model: 'gpt-5.5', created_at: 7 } },
      { type: 'response.output_text.delta', delta: 'hi' },
      { type: 'response.completed', response: { id: 'r_u', status: 'completed', usage } },
    ]

    test('emits a trailing usage chunk after the finish chunk', async () => {
      const chunks = await collect(translateResponsesToChatSSE(feed(completed({
        input_tokens: 797, output_tokens: 127, total_tokens: 924,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 18 },
      }))))
      const last = chunks.at(-1)!
      expect(last.choices).toEqual([])
      expect(last.usage).toEqual({
        prompt_tokens: 797,
        completion_tokens: 127,
        total_tokens: 924,
        // cached_tokens is 0 here, so the detail bucket is omitted entirely.
        completion_tokens_details: { reasoning_tokens: 18 },
      })
      // The finish chunk must still be the last one carrying a choice.
      expect(chunks.at(-2)!.choices[0]!.finish_reason).toBe('stop')
    })

    test('derives total_tokens and reports cached prompt tokens', async () => {
      const chunks = await collect(translateResponsesToChatSSE(feed(completed({
        input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 6 },
      }))))
      expect(chunks.at(-1)!.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 6 },
      })
    })

    test('emits no usage chunk when upstream reports none', async () => {
      const chunks = await collect(translateResponsesToChatSSE(feed(completed(undefined))))
      expect(chunks.some((c) => c.usage)).toBe(false)
      expect(chunks.at(-1)!.choices[0]!.finish_reason).toBe('stop')
    })
  })

  describe('web search sources', () => {
    // Responses carries sources on the `web_search_call` output item; Chat
    // Completions has no such item, so they travel as `delta.annotations` on
    // an otherwise-empty content delta — the same channel and shape the
    // Messages pair already uses. Without this the answer arrives with no
    // sources even though the gateway resolved them.
    const searchCall = (results: unknown) => ({
      type: 'response.output_item.done',
      output_index: 1,
      item: { type: 'web_search_call', status: 'completed', results },
    })

    const annotationsOf = (chunks: Array<{ choices: Array<{ delta: { annotations?: unknown } }> }>) =>
      chunks.flatMap((c) => c.choices[0]?.delta.annotations ?? [])

    test('maps web_search_call results onto url_citation annotations', async () => {
      const chunks = await collect(translateResponsesToChatSSE(feed([
        { type: 'response.created', response: { id: 'r_s', model: 'gpt-5.5', created_at: 9 } },
        searchCall([
          { type: 'text_result', url: 'https://a.example/x', title: 'A', snippet: 's' },
          { type: 'text_result', url: 'https://b.example/y', title: 'B', snippet: 's' },
        ]),
        { type: 'response.output_text.delta', delta: '晴' },
        { type: 'response.completed', response: { id: 'r_s', status: 'completed' } },
      ])))
      expect(annotationsOf(chunks)).toEqual([
        { type: 'url_citation', url_citation: { url: 'https://a.example/x', title: 'A' } },
        { type: 'url_citation', url_citation: { url: 'https://b.example/y', title: 'B' } },
      ])
      // Sources ride an empty content delta; the answer text is untouched.
      const text = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')
      expect(text).toBe('晴')
    })

    test('drops the title when absent and skips entries without a url', async () => {
      const chunks = await collect(translateResponsesToChatSSE(feed([
        { type: 'response.created', response: { id: 'r', model: 'm', created_at: 1 } },
        searchCall([
          { type: 'text_result', url: 'https://a.example/x' },
          { type: 'text_result', title: 'no url' },
          { type: 'text_result', url: '' },
        ]),
        { type: 'response.completed', response: { id: 'r', status: 'completed' } },
      ])))
      expect(annotationsOf(chunks)).toEqual([
        { type: 'url_citation', url_citation: { url: 'https://a.example/x' } },
      ])
    })

    test('does not re-cite a url a second search returns again', async () => {
      const chunks = await collect(translateResponsesToChatSSE(feed([
        { type: 'response.created', response: { id: 'r', model: 'm', created_at: 1 } },
        searchCall([{ type: 'text_result', url: 'https://dup.example', title: 'D' }]),
        searchCall([
          { type: 'text_result', url: 'https://dup.example', title: 'D' },
          { type: 'text_result', url: 'https://new.example', title: 'N' },
        ]),
        { type: 'response.completed', response: { id: 'r', status: 'completed' } },
      ])))
      expect(annotationsOf(chunks)).toEqual([
        { type: 'url_citation', url_citation: { url: 'https://dup.example', title: 'D' } },
        { type: 'url_citation', url_citation: { url: 'https://new.example', title: 'N' } },
      ])
    })

    test('emits nothing when results are absent (client did not opt in)', async () => {
      const chunks = await collect(translateResponsesToChatSSE(feed([
        { type: 'response.created', response: { id: 'r', model: 'm', created_at: 1 } },
        { type: 'response.output_item.done', output_index: 1,
          item: { type: 'web_search_call', status: 'completed' } },
        { type: 'response.completed', response: { id: 'r', status: 'completed' } },
      ])))
      expect(annotationsOf(chunks)).toEqual([])
    })

    test('a completed web_search_call does not make the turn finish as tool_calls', async () => {
      const chunks = await collect(translateResponsesToChatSSE(feed([
        { type: 'response.created', response: { id: 'r', model: 'm', created_at: 1 } },
        searchCall([{ type: 'text_result', url: 'https://a.example', title: 'A' }]),
        { type: 'response.output_text.delta', delta: 'x' },
        { type: 'response.completed', response: { id: 'r', status: 'completed' } },
      ])))
      // The search already ran server-side; the client owes no tool result.
      expect(chunks.at(-1)!.choices[0]!.finish_reason).toBe('stop')
    })
  })
})
