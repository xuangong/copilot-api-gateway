import { describe, it, expect } from 'bun:test'
import { translateGeminiToChat } from '@vibe-llm/translate/gemini-via-chat-completions'

type Msg = {
  role: string
  content: unknown
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  reasoning_text?: string
  reasoning_opaque?: string
}
type Out = Record<string, unknown> & { messages: Msg[] }

const run = (payload: Record<string, unknown>, options: { model?: string; fallbackMaxOutputTokens?: number } = {}): Out =>
  translateGeminiToChat(payload as never, { model: 'gpt-x', ...options }) as unknown as Out

const user = (...parts: unknown[]) => ({ role: 'user', parts })
const hello = [user({ text: 'hi' })]

describe('gemini-via-chat-completions :: request', () => {
  it('sets model, forces stream, and joins systemInstruction parts into a system message', () => {
    const out = run({
      systemInstruction: { parts: [{ text: 'be brief' }, { text: 'be kind' }] },
      contents: hello,
    })
    expect(out.model).toBe('gpt-x')
    expect(out.stream).toBe(true)
    expect(out.messages).toEqual([
      { role: 'system', content: 'be brief\n\nbe kind' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('maps multi-turn roles (user/model/absent role) in order', () => {
    const out = run({
      contents: [
        { role: 'user', parts: [{ text: 'q1' }] },
        { role: 'model', parts: [{ text: 'a1' }] },
        { parts: [{ text: 'q2' }] },
      ],
    })
    expect(out.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'q1'],
      ['assistant', 'a1'],
      ['user', 'q2'],
    ])
  })

  it('rejects unknown content roles', () => {
    expect(() => run({ contents: [{ role: 'system', parts: [{ text: 'x' }] }] })).toThrow(/content roles/)
  })

  const media: Array<[string, string, Record<string, unknown>]> = [
    ['image', 'image/png', { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }],
    ['pdf', 'application/pdf', { type: 'file', file: { file_data: 'data:application/pdf;base64,AAA' } }],
    ['mp3 audio', 'audio/mpeg', { type: 'input_audio', input_audio: { data: 'AAA', format: 'mp3' } }],
    ['wav audio', 'audio/wav', { type: 'input_audio', input_audio: { data: 'AAA', format: 'wav' } }],
  ]
  it.each(media)('maps %s inlineData next to text, preserving part order', (_name, mimeType, expected) => {
    const out = run({ contents: [user({ text: 'look' }, { inlineData: { mimeType, data: 'AAA' } })] })
    expect(out.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'look' }, expected] })
  })

  it('rejects unsupported inlineData MIME types instead of dropping them', () => {
    expect(() => run({ contents: [user({ inlineData: { mimeType: 'video/mp4', data: 'AAA' } })] })).toThrow(/video\/mp4/)
  })

  it('translates functionDeclarations into tools with description and parameters', () => {
    const parameters = { type: 'object', properties: { city: { type: 'string' } } }
    const out = run({
      contents: hello,
      tools: [{ functionDeclarations: [{ name: 'weather', description: 'get it', parameters }, { name: 'bare' }] }],
    })
    expect(out.tools).toEqual([
      { type: 'function', function: { name: 'weather', description: 'get it', parameters } },
      { type: 'function', function: { name: 'bare' } },
    ])
    expect(out.tool_choice).toBeUndefined()
  })

  it('omits tools when none are declared', () => {
    const out = run({ contents: hello })
    expect(out.tools).toBeUndefined()
    expect(out.tool_choice).toBeUndefined()
  })

  it('maps googleSearch to web_search_options without adding a tool', () => {
    const out = run({ contents: hello, tools: [{ googleSearch: {} }] })
    expect(out.web_search_options).toEqual({})
    expect(out.tools).toBeUndefined()
  })

  it('maps functionCall / functionResponse history to tool_calls and tool messages with matching ids', () => {
    const out = run({
      contents: [
        user({ text: 'weather?' }),
        { role: 'model', parts: [{ text: 'checking' }, { functionCall: { id: 'c1', name: 'weather', args: { city: 'SF' } } }, { functionCall: { name: 'time', args: {} } }] },
        user({ functionResponse: { id: 'c1', name: 'weather', response: { temp: 60 } } }, { functionResponse: { name: 'time', response: { now: 'noon' } } }),
      ],
    })
    expect(out.messages[1]).toEqual({
      role: 'assistant',
      content: 'checking',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"SF"}' } },
        { id: 'gemini_call_1_2', type: 'function', function: { name: 'time', arguments: '{}' } },
      ],
    })
    expect(out.messages.slice(2)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: '{"temp":60}' },
      { role: 'tool', tool_call_id: 'gemini_call_1_2', content: '{"now":"noon"}' },
    ])
  })

  it('splits user text around a functionResponse into separate messages', () => {
    const out = run({
      contents: [
        { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'f', args: {} } }] },
        user({ text: 'before' }, { functionResponse: { id: 'c1', name: 'f', response: {} } }, { text: 'after' }),
      ],
    })
    expect(out.messages.slice(1).map((m) => m.role)).toEqual(['user', 'tool', 'user'])
  })

  const modes: Array<[string, Record<string, unknown>, unknown]> = [
    ['AUTO', { mode: 'AUTO' }, 'auto'],
    ['VALIDATED', { mode: 'VALIDATED' }, 'auto'],
    ['NONE', { mode: 'NONE' }, 'none'],
    ['ANY', { mode: 'ANY' }, 'required'],
    ['ANY with one allowed name', { mode: 'ANY', allowedFunctionNames: ['a'] }, { type: 'function', function: { name: 'a' } }],
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
    expect((out.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(['a', 'c'])
    expect(out.tool_choice).toBe('required')
  })

  it('maps generationConfig sampling fields', () => {
    const out = run({
      contents: hello,
      generationConfig: {
        temperature: 0.3,
        topP: 0.8,
        maxOutputTokens: 256,
        stopSequences: ['END', 'STOP'],
        candidateCount: 2,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        seed: 7,
      },
    })
    expect(out).toMatchObject({
      temperature: 0.3,
      top_p: 0.8,
      max_tokens: 256,
      stop: ['END', 'STOP'],
      n: 2,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      seed: 7,
    })
  })

  it('uses fallbackMaxOutputTokens only when maxOutputTokens is absent', () => {
    expect(run({ contents: hello }, { fallbackMaxOutputTokens: 99 }).max_tokens).toBe(99)
    expect(run({ contents: hello, generationConfig: { maxOutputTokens: 5 } }, { fallbackMaxOutputTokens: 99 }).max_tokens).toBe(5)
    expect(run({ contents: hello }).max_tokens).toBeUndefined()
  })

  it('maps responseSchema to json_schema and plain JSON mime type to json_object', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    expect(run({ contents: hello, generationConfig: { responseMimeType: 'application/json', responseSchema: schema } }).response_format)
      .toEqual({ type: 'json_schema', json_schema: { name: 'gemini_response', schema } })
    expect(run({ contents: hello, generationConfig: { responseMimeType: 'application/json' } }).response_format)
      .toEqual({ type: 'json_object' })
    expect(run({ contents: hello, generationConfig: { responseMimeType: 'text/plain' } }).response_format).toBeUndefined()
  })

  const thinking: Array<[Record<string, unknown>, string | undefined]> = [
    [{ thinkingBudget: 0 }, 'none'],
    [{ thinkingBudget: 1024 }, 'low'],
    [{ thinkingBudget: 8192 }, 'medium'],
    [{ thinkingBudget: 20000 }, 'high'],
    [{ thinkingBudget: -1 }, undefined],
    [{ thinkingLevel: 'HIGH' }, 'high'],
  ]
  it.each(thinking)('thinkingConfig %j -> reasoning_effort %s', (thinkingConfig, effort) => {
    expect(run({ contents: hello, generationConfig: { thinkingConfig } }).reasoning_effort).toBe(effort)
  })

  it('replays thought parts as reasoning_text/reasoning_opaque on the assistant message', () => {
    const out = run({
      contents: [{ role: 'model', parts: [{ text: 'hmm', thought: true, thoughtSignature: 'SIG' }, { text: 'answer' }] }],
    })
    expect(out.messages).toEqual([{ role: 'assistant', content: 'answer', reasoning_text: 'hmm', reasoning_opaque: 'SIG' }])
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
      generationConfig: { stopSequences: ['x'], responseSchema: { type: 'object' } },
    }
    const snapshot = structuredClone(payload)
    const out = run(payload)
    expect(payload).toEqual(snapshot)
    ;(out.tools as Array<{ function: { parameters: { type: string } } }>)[0]!.function.parameters.type = 'mutated'
    ;(out.stop as string[]).push('y')
    expect(payload).toEqual(snapshot)
  })
})
