import { describe, test, expect } from 'bun:test'
import { translateChatToResponses } from '../../src/chat-completions-via-responses/index.ts'

describe('translateChatToResponses', () => {
  test('user-only string message produces single input message', () => {
    const out = translateChatToResponses({
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'hello' }],
    } as never)
    expect(out.target.model).toBe('gpt-x')
    expect(out.target.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
    ])
    expect(out.target.stream).toBe(true)
    expect(out.target.instructions).toBeUndefined()
  })

  test('multiple system messages merge into instructions', () => {
    const out = translateChatToResponses({
      model: 'm',
      messages: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' },
      ],
    } as never)
    expect(out.target.instructions).toBe('A\n\nB')
    expect(out.target.input).toEqual([
      { type: 'message', role: 'user', content: 'hi' },
    ])
  })

  test('image_url part becomes input_image', () => {
    const out = translateChatToResponses({
      model: 'm',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image_url', image_url: { url: 'https://x/y.png' } },
        ],
      }],
    } as never)
    expect(out.target.input).toEqual([{
      type: 'message', role: 'user',
      content: [
        { type: 'input_text', text: 'see' },
        { type: 'input_image', text: 'https://x/y.png' },
      ],
    }])
  })

  test('assistant tool_calls become function_call items', () => {
    const out = translateChatToResponses({
      model: 'm',
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result' },
      ],
    } as never)
    expect(out.target.input).toEqual([
      { type: 'message', role: 'user', content: 'q' },
      { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"x":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ])
  })

  test('tools[] become function tools with strict:false', () => {
    const out = translateChatToResponses({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    } as never)
    expect(out.target.tools).toEqual([
      { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: false },
    ])
    expect(out.target.tool_choice).toBe('auto')
  })

  test('tool_choice object → function-name shape', () => {
    const out = translateChatToResponses({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
      tool_choice: { type: 'function', function: { name: 'f' } },
    } as never)
    expect(out.target.tool_choice).toEqual({ type: 'function', name: 'f' })
  })

  test('max_tokens forwarded to max_output_tokens; fallback used only when absent', () => {
    const a = translateChatToResponses(
      { model: 'm', messages: [{ role: 'user', content: 'q' }], max_tokens: 100 } as never,
      { fallbackMaxOutputTokens: 4096 },
    )
    expect(a.target.max_output_tokens).toBe(100)
    const b = translateChatToResponses(
      { model: 'm', messages: [{ role: 'user', content: 'q' }] } as never,
      { fallbackMaxOutputTokens: 4096 },
    )
    expect(b.target.max_output_tokens).toBe(4096)
    const c = translateChatToResponses(
      { model: 'm', messages: [{ role: 'user', content: 'q' }] } as never,
    )
    expect(c.target.max_output_tokens).toBeUndefined()
  })

  test('stream:false passes through verbatim', () => {
    const out = translateChatToResponses({
      model: 'm', stream: false,
      messages: [{ role: 'user', content: 'q' }],
    } as never)
    expect(out.target.stream).toBe(false)
  })
})
