import { describe, it, expect } from 'bun:test'
import { translateChatToGeminiBody } from '@vibe-llm/translate/gemini-via-chat-completions'

const run = (body: Record<string, unknown>, model = 'gemini-x') =>
  translateChatToGeminiBody(body as never, { model })

const textBody = (finish_reason: string | null, extra: Record<string, unknown> = {}) => ({
  id: 'c1',
  model: 'upstream-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason }],
  ...extra,
})

describe('gemini-via-chat-completions :: body', () => {
  it('translates a text reply into one model candidate with the option model as modelVersion', async () => {
    const out = await run(textBody('stop'))
    expect(out).toEqual({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
      modelVersion: 'gemini-x',
    })
  })

  const finishes: Array<[string | null, string]> = [
    ['stop', 'STOP'],
    ['tool_calls', 'STOP'],
    ['length', 'MAX_TOKENS'],
    ['content_filter', 'SAFETY'],
    [null, 'STOP'],
  ]
  it.each(finishes)('finish_reason %s -> %s', async (reason, expected) => {
    const out = await run(textBody(reason))
    expect(out.candidates?.[0]?.finishReason).toBe(expected as never)
  })

  it('translates tool_calls into functionCall parts with parsed args and ids', async () => {
    const out = await run({
      id: 'c1',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"SF"}' } },
            { id: 'call_2', type: 'function', function: { name: 'time', arguments: '' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    })
    expect(out.candidates?.[0]?.content?.parts).toEqual([
      { functionCall: { id: 'call_1', name: 'weather', args: { city: 'SF' } } },
      { functionCall: { id: 'call_2', name: 'time', args: {} } },
    ])
    expect(out.candidates?.[0]?.finishReason).toBe('STOP')
  })

  it('rejects tool_calls whose arguments are not a JSON object', async () => {
    await expect(run({
      choices: [{ index: 0, message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '[1]' } }] }, finish_reason: 'tool_calls' }],
    })).rejects.toThrow(/JSON object/)
  })

  it('maps usage to usageMetadata including cached and reasoning tokens', async () => {
    const out = await run(textBody('stop', {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        completion_tokens_details: { reasoning_tokens: 2 },
        prompt_tokens_details: { cached_tokens: 4 },
      },
    }))
    expect(out.usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
      thoughtsTokenCount: 2,
      cachedContentTokenCount: 4,
    })
  })

  it('omits usageMetadata when the body has no usage', async () => {
    expect('usageMetadata' in (await run(textBody('stop')))).toBe(false)
  })

  it('emits reasoning as a thought part with its signature, before visible text', async () => {
    const out = await run({
      choices: [{
        index: 0,
        message: { content: 'answer', reasoning_text: 'thinking', reasoning_opaque: 'SIG' },
        finish_reason: 'stop',
      }],
    })
    expect(out.candidates?.[0]?.content?.parts).toEqual([
      { text: 'answer' },
      { text: 'thinking', thought: true, thoughtSignature: 'SIG' },
    ])
  })

  it('keeps multiple choices as separate ordered candidates', async () => {
    const out = await run({
      choices: [
        { index: 1, message: { content: 'second' }, finish_reason: 'length' },
        { index: 0, message: { content: 'first' }, finish_reason: 'stop' },
      ],
    })
    expect(out.candidates?.map((c) => [c.index, c.content?.parts, c.finishReason])).toEqual([
      [0, [{ text: 'first' }], 'STOP'],
      [1, [{ text: 'second' }], 'MAX_TOKENS'],
    ])
  })

  it('turns url_citation annotations into deduplicated groundingMetadata', async () => {
    const out = await run({
      choices: [{
        index: 0,
        message: {
          content: 'cited',
          annotations: [
            { type: 'url_citation', url_citation: { url: 'https://a.example', title: 'A' } },
            { type: 'url_citation', url_citation: { url: 'https://a.example', title: 'dup' } },
            { type: 'url_citation', url_citation: { url: 'https://b.example' } },
          ],
        },
        finish_reason: 'stop',
      }],
    })
    expect(out.candidates?.[0]?.groundingMetadata).toEqual({
      groundingChunks: [{ web: { uri: 'https://a.example', title: 'A' } }, { web: { uri: 'https://b.example' } }],
    })
  })

  it('returns an empty model candidate when there are no choices', async () => {
    const out = await run({ choices: [] })
    expect(out.candidates).toEqual([{ index: 0, content: { role: 'model', parts: [] } }])
  })

  it('does not mutate the input body', async () => {
    const body = textBody('stop', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    const snapshot = structuredClone(body)
    await run(body)
    expect(body).toEqual(snapshot)
  })
})
