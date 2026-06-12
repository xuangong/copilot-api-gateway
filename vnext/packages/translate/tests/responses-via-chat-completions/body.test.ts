import { describe, test, expect } from 'bun:test'
import { translateChatToResponsesBody } from '../../src/responses-via-chat-completions/index.ts'

describe('translateChatToResponsesBody', () => {
  test('text-only chat completion → responses with output_text item', () => {
    const out = translateChatToResponsesBody({
      id: 'c1', model: 'm', created: 100,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }) as { id: string; model: string; created_at: number; status: string; output: Array<{ type: string; content?: Array<{ type: string; text: string }> }>; usage: { input_tokens: number; output_tokens: number } }
    expect(out.id).toBe('c1')
    expect(out.created_at).toBe(100)
    expect(out.status).toBe('completed')
    expect(out.output[0]).toEqual({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } as never)
    expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 1 })
  })

  test('tool_calls produce function_call output items', () => {
    const out = translateChatToResponsesBody({
      id: 'c2', model: 'm', created: 1,
      choices: [{ index: 0, message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }],
      }, finish_reason: 'tool_calls' }],
    }) as { output: Array<{ type: string; call_id?: string; name?: string; arguments?: string }> }
    expect(out.output).toEqual([
      { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '{"x":1}' },
    ] as never)
  })

  test('finish:length → status:incomplete', () => {
    const out = translateChatToResponsesBody({
      id: 'c3', model: 'm', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'length' }],
    }) as { status: string; incomplete_details: { reason: string } }
    expect(out.status).toBe('incomplete')
    expect(out.incomplete_details.reason).toBe('max_output_tokens')
  })
})
