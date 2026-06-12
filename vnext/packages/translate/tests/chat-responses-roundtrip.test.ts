import { describe, test, expect } from 'bun:test'
import { translateChatToResponses } from '../src/chat-completions-via-responses/index.ts'
import { translateResponsesToChat } from '../src/responses-via-chat-completions/index.ts'

describe('chat ↔ responses round-trip', () => {
  test('chat → responses → chat preserves text + tools', () => {
    const original = {
      model: 'm',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    }
    const r = translateChatToResponses(original as never).target
    const back = translateResponsesToChat(r as never).target
    expect(back.model).toBe('m')
    expect(back.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(back.messages[1]).toEqual({ role: 'user', content: 'hi' })
    expect(back.tools).toEqual([{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }] as never)
    expect(back.tool_choice).toBe('auto')
  })

  test('responses → chat → responses preserves function_call/output', () => {
    const original = {
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '{"x":1}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'r' },
      ],
    }
    const c = translateResponsesToChat(original as never).target
    const back = translateChatToResponses(c as never).target
    expect(back.input).toEqual([
      { type: 'message', role: 'user', content: 'q' },
      { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '{"x":1}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'r' },
    ] as never)
  })
})
