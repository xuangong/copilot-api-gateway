import { describe, it, expect } from 'bun:test'
import { translateGeminiToResponses } from '@vibe-llm/translate/gemini-via-responses'

type Out = Record<string, unknown> & { input: Array<Record<string, unknown>> }

const run = (payload: Record<string, unknown>, options: { model?: string; fallbackMaxOutputTokens?: number } = {}): Out =>
  translateGeminiToResponses(payload as never, { model: 'gpt-x', ...options }) as unknown as Out

const user = (...parts: unknown[]) => ({ role: 'user', parts })
const hello = [user({ text: 'hi' })]

describe('gemini-via-responses :: request', () => {
  it('sets model, forces stream, and joins systemInstruction parts into instructions', () => {
    const out = run({
      systemInstruction: { parts: [{ text: 'be brief' }, { text: 'be kind' }] },
      contents: hello,
    })
    expect(out.model).toBe('gpt-x')
    expect(out.stream).toBe(true)
    expect(out.instructions).toBe('be brief\n\nbe kind')
    expect(out.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
  })

  it('omits instructions without a systemInstruction', () => {
    expect(run({ contents: hello }).instructions).toBeUndefined()
  })

  it('maps multi-turn roles: user -> input_text, model -> output_text', () => {
    const out = run({
      contents: [
        { role: 'user', parts: [{ text: 'q1' }] },
        { role: 'model', parts: [{ text: 'a1' }] },
        { parts: [{ text: 'q2' }] },
      ],
    })
    expect(out.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q1' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a1' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q2' }] },
    ])
  })

  it('rejects unknown content roles', () => {
    expect(() => run({ contents: [{ role: 'system', parts: [{ text: 'x' }] }] })).toThrow(/content roles/)
  })

  const media: Array<[string, string, Record<string, unknown>]> = [
    ['image', 'image/jpeg', { type: 'input_image', image_url: 'data:image/jpeg;base64,AAA', detail: 'auto' }],
    ['pdf', 'application/pdf', { type: 'input_file', file_data: 'data:application/pdf;base64,AAA' }],
  ]
  it.each(media)('maps %s inlineData next to text in one user message', (_name, mimeType, expected) => {
    const out = run({ contents: [user({ text: 'look' }, { inlineData: { mimeType, data: 'AAA' } })] })
    expect(out.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, expected] },
    ])
  })

  it('rejects audio and other unsupported inlineData instead of dropping it', () => {
    expect(() => run({ contents: [user({ inlineData: { mimeType: 'audio/wav', data: 'AAA' } })] })).toThrow(/audio\/wav/)
    expect(() => run({ contents: [user({ inlineData: { mimeType: 'video/mp4', data: 'AAA' } })] })).toThrow(/video\/mp4/)
  })

  it('translates functionDeclarations into non-strict function tools', () => {
    const parameters = { type: 'object', properties: { city: { type: 'string' } } }
    const out = run({
      contents: hello,
      tools: [{ functionDeclarations: [{ name: 'weather', description: 'get it', parameters }, { name: 'bare' }] }],
    })
    expect(out.tools).toEqual([
      { type: 'function', name: 'weather', description: 'get it', parameters, strict: false },
      { type: 'function', name: 'bare', parameters: { type: 'object', properties: {} }, strict: false },
    ])
    expect(out.tool_choice).toBeUndefined()
    expect(out.include).toBeUndefined()
  })

  it('maps googleSearch to a web_search tool and opts into result sources', () => {
    const out = run({ contents: hello, tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: 'f' }] }] })
    expect(out.tools).toEqual([
      { type: 'function', name: 'f', parameters: { type: 'object', properties: {} }, strict: false },
      { type: 'web_search' },
    ])
    expect(out.include).toEqual(['web_search_call.results'])
  })

  it('maps functionCall / functionResponse history to function_call and function_call_output items with matching ids', () => {
    const out = run({
      contents: [
        user({ text: 'weather?' }),
        { role: 'model', parts: [{ text: 'checking' }, { functionCall: { id: 'c1', name: 'weather', args: { city: 'SF' } } }, { functionCall: { name: 'time', args: {} } }] },
        user({ functionResponse: { id: 'c1', name: 'weather', response: { temp: 60 } } }, { functionResponse: { name: 'time', response: { now: 'noon' } } }),
      ],
    })
    expect(out.input.slice(1)).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
      { type: 'function_call', call_id: 'c1', name: 'weather', arguments: '{"city":"SF"}', status: 'completed' },
      { type: 'function_call', call_id: 'gemini_call_1_2', name: 'time', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'c1', output: '{"temp":60}', status: 'completed' },
      { type: 'function_call_output', call_id: 'gemini_call_1_2', output: '{"now":"noon"}', status: 'completed' },
    ])
  })

  it('splits user text around a functionResponse', () => {
    const out = run({
      contents: [
        { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'f', args: {} } }] },
        user({ text: 'before' }, { functionResponse: { id: 'c1', name: 'f', response: {} } }, { text: 'after' }),
      ],
    })
    expect(out.input.slice(1).map((i) => i.type)).toEqual(['message', 'function_call_output', 'message'])
  })

  const modes: Array<[string, Record<string, unknown>, unknown]> = [
    ['AUTO', { mode: 'AUTO' }, 'auto'],
    ['VALIDATED', { mode: 'VALIDATED' }, 'auto'],
    ['NONE', { mode: 'NONE' }, 'none'],
    ['ANY', { mode: 'ANY' }, 'required'],
    ['ANY with one allowed name', { mode: 'ANY', allowedFunctionNames: ['a'] }, { type: 'function', name: 'a' }],
  ]
  it.each(modes)('functionCallingConfig %s -> tool_choice', (_label, config, expected) => {
    const out = run({
      contents: hello,
      tools: [{ functionDeclarations: [{ name: 'a' }, { name: 'b' }] }],
      toolConfig: { functionCallingConfig: config },
    })
    expect(out.tool_choice).toEqual(expected)
  })

  it('ANY with several allowed names filters tools and requires a call', () => {
    const out = run({
      contents: hello,
      tools: [{ functionDeclarations: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['a', 'c'] } },
    })
    expect((out.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['a', 'c'])
    expect(out.tool_choice).toBe('required')
  })

  it('maps temperature, topP and maxOutputTokens to max_output_tokens', () => {
    const out = run({ contents: hello, generationConfig: { temperature: 0.3, topP: 0.8, maxOutputTokens: 256 } })
    expect(out).toMatchObject({ temperature: 0.3, top_p: 0.8, max_output_tokens: 256 })
    expect(out.max_tokens).toBeUndefined()
  })

  it('uses fallbackMaxOutputTokens only when maxOutputTokens is absent', () => {
    expect(run({ contents: hello }, { fallbackMaxOutputTokens: 99 }).max_output_tokens).toBe(99)
    expect(run({ contents: hello, generationConfig: { maxOutputTokens: 5 } }, { fallbackMaxOutputTokens: 99 }).max_output_tokens).toBe(5)
    expect(run({ contents: hello }).max_output_tokens).toBeUndefined()
  })

  it('maps a JSON response mime type to text.format json_object', () => {
    expect(run({ contents: hello, generationConfig: { responseMimeType: 'application/json' } }).text)
      .toEqual({ format: { type: 'json_object' } })
    expect(run({ contents: hello, generationConfig: { responseMimeType: 'text/plain' } }).text).toBeUndefined()
  })

  const thinking: Array<[Record<string, unknown>, Record<string, unknown> | undefined]> = [
    [{ thinkingBudget: 0 }, { effort: 'none' }],
    [{ thinkingBudget: 1024 }, { effort: 'low' }],
    [{ thinkingBudget: 8192 }, { effort: 'medium' }],
    [{ thinkingBudget: 20000 }, { effort: 'high' }],
    [{ thinkingBudget: -1 }, undefined],
    [{ thinkingLevel: 'LOW' }, { effort: 'low' }],
    [{ thinkingLevel: 'HIGH', includeThoughts: true }, { effort: 'high', summary: 'detailed' }],
    [{ thinkingBudget: 0, includeThoughts: true }, { effort: 'none' }],
  ]
  it.each(thinking)('thinkingConfig %j -> reasoning %j', (thinkingConfig, reasoning) => {
    expect(run({ contents: hello, generationConfig: { thinkingConfig } }).reasoning).toEqual(reasoning)
  })

  it('replays thought parts as reasoning items with the signature as encrypted_content', () => {
    const out = run({
      contents: [{ role: 'model', parts: [{ text: 'hmm', thought: true, thoughtSignature: 'SIG' }, { text: 'answer' }] }],
    })
    expect(out.input).toEqual([
      { type: 'reasoning', encrypted_content: 'SIG', id: 'gemini_reasoning_0_0', summary: [{ type: 'summary_text', text: 'hmm' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ])
  })

  it('does not mutate the source payload', () => {
    const payload = {
      systemInstruction: { parts: [{ text: 's' }] },
      contents: [
        user({ text: 'q' }, { inlineData: { mimeType: 'image/png', data: 'AAA' } }),
        { role: 'model', parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] },
        user({ functionResponse: { name: 'f', response: { ok: true } } }),
      ],
      tools: [{ functionDeclarations: [{ name: 'f', parameters: { type: 'object', properties: {} } }] }],
      generationConfig: { stopSequences: ['x'], responseMimeType: 'application/json' },
    }
    const snapshot = structuredClone(payload)
    const out = run(payload)
    expect(payload).toEqual(snapshot)
    ;(out.tools as Array<{ parameters: { type: string } }>)[0]!.parameters.type = 'mutated'
    expect(payload).toEqual(snapshot)
  })
})
