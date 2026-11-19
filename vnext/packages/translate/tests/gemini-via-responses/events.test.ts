import { describe, it, expect } from 'bun:test'
import { translateResponsesToGeminiEvents } from '@vibe-llm/translate/gemini-via-responses'

async function* fromArray<T>(items: T[]): AsyncGenerator<T> { for (const it of items) yield it }

type Ev = {
  candidates?: Array<{ index?: number; content?: { role?: string; parts?: Array<Record<string, unknown>> }; finishReason?: string; groundingMetadata?: unknown }>
  usageMetadata?: Record<string, number>
  modelVersion?: string
}

const collect = async (events: unknown[], model?: string): Promise<Ev[]> => {
  const out: Ev[] = []
  for await (const e of translateResponsesToGeminiEvents(fromArray(events), model ? { model } : {})) out.push(e as Ev)
  return out
}
const partsOf = (events: Ev[]) => events.flatMap((e) => e.candidates?.[0]?.content?.parts ?? [])

const completed = (extra: Record<string, unknown> = {}) => ({ type: 'response.completed', response: { status: 'completed', ...extra } })

describe('gemini-via-responses :: events', () => {
  it('streams text deltas as separate candidate parts and ends with a terminal chunk', async () => {
    const out = await collect([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hel' },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'lo' },
      completed(),
    ], 'gemini-x')
    expect(out[0]).toEqual({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hel' }] } }] })
    expect(out[1]).toEqual({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'lo' }] } }] })
    expect(out[2]).toEqual({
      candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
      modelVersion: 'gemini-x',
    })
    expect(out).toHaveLength(3)
  })

  it('does not repeat text already streamed when output_text.done arrives, but emits text seen only on done', async () => {
    const out = await collect([
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'abc' },
      { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'abc' },
      { type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'only-done' },
      { type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: '' },
      completed(),
    ])
    expect(partsOf(out)).toEqual([{ text: 'abc' }, { text: 'only-done' }])
  })

  it('assembles function call argument deltas into one functionCall with the call id', async () => {
    const out = await collect([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city"' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: ':"SF"}' },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"city":"SF"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{"city":"SF"}' } },
      completed(),
    ])
    expect(partsOf(out)).toEqual([{ functionCall: { id: 'call_1', name: 'weather', args: { city: 'SF' } } }])
    expect(out.filter((e) => e.candidates?.[0]?.content?.parts?.length)).toHaveLength(1)
  })

  it('assembles argument deltas alone when neither arguments.done nor the done item carries them', async () => {
    const out = await collect([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'f' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'f' } },
      completed(),
    ])
    expect(partsOf(out)).toEqual([{ functionCall: { id: 'c', name: 'f', args: { a: 1 } } }])
  })

  it('uses empty args for a call with no arguments and falls back to the done item when no added event was seen', async () => {
    const out = await collect([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'a', name: 'noargs' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'a', name: 'noargs' } },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'b', name: 'late', arguments: '{"x":1}' } },
      completed(),
    ])
    expect(partsOf(out)).toEqual([
      { functionCall: { id: 'a', name: 'noargs', args: {} } },
      { functionCall: { id: 'b', name: 'late', args: { x: 1 } } },
    ])
  })

  it('fails on a nameless function call and on non-object arguments', async () => {
    await expect(collect([
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'a', arguments: '{}' } },
    ])).rejects.toThrow(/without a name/)
    await expect(collect([
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'a', name: 'f', arguments: '[1]' } },
    ])).rejects.toThrow(/JSON object/)
  })

  it('emits a reasoning item once as a thought part with its signature', async () => {
    const item = { type: 'reasoning', summary: [{ text: 'step ' }, { text: 'two' }], encrypted_content: 'SIG' }
    const out = await collect([
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'step ' },
      { type: 'response.output_item.done', output_index: 0, item },
      completed({ output: [item] }),
    ])
    expect(partsOf(out)).toEqual([{ text: 'step two', thought: true, thoughtSignature: 'SIG' }])
  })

  it('terminal event carries STOP finishReason and usageMetadata', async () => {
    const out = await collect([
      completed({
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          output_tokens_details: { reasoning_tokens: 2 },
          input_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 },
        },
      }),
    ], 'm')
    expect(out).toEqual([{
      candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, thoughtsTokenCount: 2, cachedContentTokenCount: 4 },
      modelVersion: 'm',
    }])
  })

  const terminals: Array<[string, Record<string, unknown>, string]> = [
    ['response.incomplete', { incomplete_details: { reason: 'max_output_tokens' } }, 'MAX_TOKENS'],
    ['response.incomplete', { incomplete_details: { reason: 'content_filter' } }, 'OTHER'],
    ['response.incomplete', {}, 'OTHER'],
    ['response.failed', { error: { code: 'server_error', message: 'boom' } }, 'OTHER'],
    ['response.failed', { error: { code: 'content_filter', message: 'blocked' } }, 'SAFETY'],
    ['response.failed', { error: { message: 'Safety system triggered' } }, 'SAFETY'],
  ]
  it.each(terminals)('%s %j -> finishReason %s', async (type, response, expected) => {
    const out = await collect([{ type, response }])
    expect(out.at(-1)?.candidates?.[0]?.finishReason).toBe(expected)
  })

  it('attaches groundingMetadata from web_search_call results on the terminal chunk only', async () => {
    const out = await collect([
      { type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', results: [{ url: 'https://a.example', title: 'A' }, { url: 'https://a.example', title: 'dup' }, { url: 'https://b.example' }, { title: 'no url' }] } },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'x' },
      completed(),
    ])
    expect(out[0]?.candidates?.[0]?.groundingMetadata).toBeUndefined()
    expect(out.at(-1)?.candidates?.[0]?.groundingMetadata).toEqual({
      groundingChunks: [{ web: { uri: 'https://a.example', title: 'A' } }, { web: { uri: 'https://b.example' } }],
    })
  })

  it('throws on an upstream error event, after yielding what came before', async () => {
    const seen: Ev[] = []
    const run = async () => {
      for await (const e of translateResponsesToGeminiEvents(fromArray([
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' },
        { type: 'error', message: 'overloaded' },
      ]))) seen.push(e as Ev)
    }
    await expect(run()).rejects.toThrow('Upstream Responses stream error: overloaded')
    expect(partsOf(seen)).toEqual([{ text: 'partial' }])
  })

  it('stops reading at the terminal event and ignores unknown/non-object events', async () => {
    const out = await collect([
      null,
      'junk',
      { type: 'response.in_progress' },
      { type: 42 },
      completed(),
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'after' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.candidates?.[0]?.finishReason).toBe('STOP')
  })

  it('rejects events carrying native continuation state a Gemini client cannot hold', async () => {
    await expect(collect([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'compaction' } },
    ])).rejects.toThrow(/cannot be represented/)
  })

  it('yields nothing when the stream ends without a terminal event', async () => {
    expect(await collect([])).toEqual([])
  })
})
