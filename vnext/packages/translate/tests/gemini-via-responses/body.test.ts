import { describe, it, expect } from 'bun:test'
import { translateResponsesToGeminiBody } from '@vibe-llm/translate/gemini-via-responses'

const run = (body: Record<string, unknown>, model = 'gemini-x') =>
  translateResponsesToGeminiBody(body as never, { model })

const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })

describe('gemini-via-responses :: body', () => {
  it('translates a text reply into one model candidate with the option model as modelVersion', async () => {
    const out = await run({ id: 'r1', model: 'upstream', status: 'completed', output: [message('hello')] })
    expect(out).toEqual({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
      modelVersion: 'gemini-x',
    })
  })

  it('defaults a missing status to STOP', async () => {
    const out = await run({ output: [message('x')] })
    expect(out.candidates?.[0]?.finishReason).toBe('STOP')
  })

  const finishes: Array<[string, Record<string, unknown>, string]> = [
    ['completed', {}, 'STOP'],
    ['incomplete / max_output_tokens', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'MAX_TOKENS'],
    ['incomplete / other reason', { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'OTHER'],
    ['incomplete / no details', { status: 'incomplete' }, 'OTHER'],
    ['failed', { status: 'failed', error: { code: 'server_error', message: 'boom' } }, 'OTHER'],
    ['failed / safety error', { status: 'failed', error: { code: 'content_filter', message: 'blocked' } }, 'SAFETY'],
    ['failed / policy error', { status: 'failed', error: { type: 'invalid_prompt', message: 'Policy violation' } }, 'SAFETY'],
  ]
  it.each(finishes)('%s -> %s', async (_label, extra, expected) => {
    const out = await run({ output: [message('x')], ...extra })
    expect(out.candidates?.[0]?.finishReason).toBe(expected as never)
  })

  it('translates function_call items into functionCall parts with parsed args and call ids', async () => {
    const out = await run({
      status: 'completed',
      output: [
        message('calling'),
        { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{"city":"SF"}' },
        { type: 'function_call', call_id: 'call_2', name: 'time', arguments: '' },
      ],
    })
    expect(out.candidates?.[0]?.content?.parts).toEqual([
      { text: 'calling' },
      { functionCall: { id: 'call_1', name: 'weather', args: { city: 'SF' } } },
      { functionCall: { id: 'call_2', name: 'time', args: {} } },
    ])
  })

  it('rejects function_call arguments that are not a JSON object', async () => {
    await expect(run({ output: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '[1]' }] })).rejects.toThrow(/JSON object/)
  })

  it('maps usage to usageMetadata including cached and reasoning tokens (cache writes are dropped)', async () => {
    const out = await run({
      output: [message('x')],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        output_tokens_details: { reasoning_tokens: 2 },
        input_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 },
      },
    })
    expect(out.usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
      thoughtsTokenCount: 2,
      cachedContentTokenCount: 4,
    })
  })

  it('omits usageMetadata when the body has no usage', async () => {
    expect('usageMetadata' in (await run({ output: [message('x')] }))).toBe(false)
  })

  it('emits reasoning items as thought parts in output order', async () => {
    const out = await run({
      output: [{ type: 'reasoning', summary: [{ text: 'step 1 ' }, { text: 'step 2' }] }, message('answer')],
    })
    expect(out.candidates?.[0]?.content?.parts).toEqual([{ text: 'step 1 step 2', thought: true }, { text: 'answer' }])
  })

  it('turns web_search_call results into deduplicated groundingMetadata', async () => {
    const out = await run({
      output: [
        { type: 'web_search_call', results: [{ url: 'https://a.example', title: 'A' }, { url: 'https://a.example', title: 'dup' }] },
        { type: 'web_search_call', results: [{ url: 'https://b.example' }] },
        message('cited'),
      ],
    })
    expect(out.candidates?.[0]?.groundingMetadata).toEqual({
      groundingChunks: [{ web: { uri: 'https://a.example', title: 'A' } }, { web: { uri: 'https://b.example' } }],
    })
  })

  it('returns a candidate with no parts for an empty output', async () => {
    const out = await run({ status: 'completed', output: [] })
    expect(out.candidates).toEqual([{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }])
  })

  it('does not mutate the input body', async () => {
    const body = { status: 'completed', output: [message('x'), { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    const snapshot = structuredClone(body)
    await run(body)
    expect(body).toEqual(snapshot)
  })
})
