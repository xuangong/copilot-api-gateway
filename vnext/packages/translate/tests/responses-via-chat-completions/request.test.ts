import { describe, test, expect } from 'bun:test'
import { translateResponsesToChat } from '../../src/responses-via-chat-completions/index.ts'

describe('translateResponsesToChat', () => {
  test('instructions prepended as system; input message becomes chat user', () => {
    const out = translateResponsesToChat({
      model: 'm',
      instructions: 'You are helpful.',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    } as never)
    expect(out.target.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ])
  })

  test('input_image part → image_url part', () => {
    const out = translateResponsesToChat({
      model: 'm',
      input: [{
        type: 'message', role: 'user',
        content: [
          { type: 'input_text', text: 'see' },
          { type: 'input_image', text: 'https://x/y.png' },
        ],
      }],
    } as never)
    expect(out.target.messages[0].content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
    ])
  })

  test('function_call + function_call_output → assistant.tool_calls + role:tool', () => {
    const out = translateResponsesToChat({
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '{"x":1}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'result' },
      ],
    } as never)
    expect(out.target.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null,
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] },
      { role: 'tool', tool_call_id: 'call_a', content: 'result' },
    ])
  })

  test('tools + tool_choice translation', () => {
    const out = translateResponsesToChat({
      model: 'm',
      input: [{ type: 'message', role: 'user', content: 'q' }],
      tools: [
        { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: false },
        { type: 'web_search' },
      ],
      tool_choice: { type: 'function', name: 'f' },
    } as never)
    expect(out.target.tools).toEqual([
      { type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } },
    ])
    expect(out.target.tool_choice).toEqual({ type: 'function', function: { name: 'f' } })
  })

  test('max_output_tokens → max_tokens; stream passthrough', () => {
    const out = translateResponsesToChat({
      model: 'm', max_output_tokens: 256, stream: false,
      input: [{ type: 'message', role: 'user', content: 'q' }],
    } as never)
    expect(out.target.max_tokens).toBe(256)
    expect(out.target.stream).toBe(false)
  })
})
