import { describe, it, expect } from 'bun:test'
import { translateMessagesToResponsesBody } from '@vnext-llm/translate/responses-via-messages'
import type { MessagesResponse } from '@vnext-llm/protocols/messages'

describe('responses-via-messages :: body', () => {
  it('expands text/thinking/tool_use into msg_/rs_/fc_ output items and accumulates output_text', () => {
    const resp = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-3',
      content: [
        { type: 'thinking', thinking: 'pondering' },
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'tu_1', name: 'fn', input: { x: 1 } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2 },
    } as unknown as MessagesResponse
    const out = translateMessagesToResponsesBody(resp)
    expect(out.id).toBe('msg_1')
    expect(out.object).toBe('response')
    expect(out.model).toBe('claude-3')
    expect(out.status).toBe('completed')
    expect(out.output_text).toBe('Hello')
    expect(out.output.length).toBe(3)
    expect(out.output[0]).toMatchObject({ type: 'reasoning' })
    expect((out.output[0]?.id ?? '').startsWith('rs_')).toBe(true)
    expect(out.output[1]).toMatchObject({ type: 'message', role: 'assistant' })
    expect((out.output[1]?.id ?? '').startsWith('msg_')).toBe(true)
    expect(out.output[2]).toMatchObject({ type: 'function_call', call_id: 'tu_1', name: 'fn', arguments: '{"x":1}', status: 'completed' })
    expect((out.output[2]?.id ?? '').startsWith('fc_')).toBe(true)
  })

  it('marks status=incomplete with incomplete_details when stop_reason is max_tokens', () => {
    const resp = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as MessagesResponse
    const out = translateMessagesToResponsesBody(resp)
    expect(out.status).toBe('incomplete')
    expect(out.incomplete_details).toEqual({ reason: 'max_output_tokens' })
  })

  it('totals usage by combining input_tokens + cache_read + cache_creation', () => {
    const resp = {
      id: 'msg_3',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    } as unknown as MessagesResponse
    const out = translateMessagesToResponsesBody(resp)
    expect(out.usage.input_tokens).toBe(15) // 10 + 3 + 2
    expect(out.usage.output_tokens).toBe(4)
    expect(out.usage.total_tokens).toBe(19) // 15 + 4
    expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 3 })
  })
})
