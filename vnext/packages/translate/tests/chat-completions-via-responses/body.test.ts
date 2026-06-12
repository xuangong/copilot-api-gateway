import { describe, test, expect } from 'bun:test'
import { translateResponsesToChatBody } from '../../src/chat-completions-via-responses/index.ts'

describe('translateResponsesToChatBody', () => {
  test('plain text response → chat completion with content + finish:stop', () => {
    const out = translateResponsesToChatBody({
      id: 'r1', model: 'gpt-x', created_at: 100, status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
      usage: { input_tokens: 3, output_tokens: 1 },
    }) as { id: string; model: string; created: number; choices: Array<{ message: { role: string; content: string | null; tool_calls?: unknown[] }; finish_reason: string }>; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
    expect(out.id).toBe('r1')
    expect(out.created).toBe(100)
    expect(out.model).toBe('gpt-x')
    expect(out.choices[0].message).toEqual({ role: 'assistant', content: 'hello' })
    expect(out.choices[0].finish_reason).toBe('stop')
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 })
  })

  test('tool_calls present → message.tool_calls + finish:tool_calls + content null', () => {
    const out = translateResponsesToChatBody({
      id: 'r2', model: 'm', created_at: 1, status: 'completed',
      output: [
        { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '{"x":1}' },
      ],
    }) as { choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }; finish_reason: string }> }
    expect(out.choices[0].message.content).toBeNull()
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
    ])
    expect(out.choices[0].finish_reason).toBe('tool_calls')
  })

  test('max_output_tokens → finish:length', () => {
    const out = translateResponsesToChatBody({
      id: 'r3', model: 'm', created_at: 1,
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x' }] }],
    }) as { choices: Array<{ finish_reason: string }> }
    expect(out.choices[0].finish_reason).toBe('length')
  })
})
