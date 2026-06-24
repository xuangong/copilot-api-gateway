import { describe, it, expect } from 'bun:test'
import { translateMessagesToChatBody } from '@vnext-llm/translate/chat-completions-via-messages'
import type { MessagesResponse } from '@vnext-llm/protocols/messages'

describe('chat-completions-via-messages :: body', () => {
  it('collapses text blocks into a single assistant message content', () => {
    const resp = {
      id: 'msg_x',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5',
      content: [
        { type: 'text', text: 'Hello, ' },
        { type: 'text', text: 'world!' },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 7 },
    } as unknown as MessagesResponse
    const out = translateMessagesToChatBody(resp)
    expect(out.id).toBe('msg_x')
    expect(out.object).toBe('chat.completion')
    expect(out.model).toBe('claude-3-5')
    expect(out.choices[0]?.message.content).toBe('Hello, world!')
    expect(out.choices[0]?.finish_reason).toBe('stop')
    expect(out.usage.prompt_tokens).toBe(5)
    expect(out.usage.completion_tokens).toBe(7)
    expect(out.usage.total_tokens).toBe(12)
  })

  it('emits tool_calls when content has tool_use blocks and stop_reason=tool_use', () => {
    const resp = {
      id: 'msg_t',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5',
      content: [
        { type: 'text', text: 'Calling…' },
        { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'cats' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    } as unknown as MessagesResponse
    const out = translateMessagesToChatBody(resp)
    expect(out.choices[0]?.finish_reason).toBe('tool_calls')
    expect(out.choices[0]?.message.tool_calls).toEqual([
      { id: 'tu_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"cats"}' } },
    ])
    // text is preserved alongside tool_calls (assistant content)
    expect(out.choices[0]?.message.content).toBe('Calling…')
  })

  it('content is null when there are no text blocks (only tool_use)', () => {
    const resp = {
      id: 'msg_o',
      type: 'message',
      role: 'assistant',
      model: 'mm',
      content: [
        { type: 'tool_use', id: 'tu_z', name: 'doit', input: {} },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as MessagesResponse
    const out = translateMessagesToChatBody(resp)
    expect(out.choices[0]?.message.content).toBeNull()
    expect(out.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe('{}')
  })

  it('maps stop_reason=max_tokens → length and refusal → content_filter (mirroring reference)', () => {
    const base = {
      id: 'msg_b', type: 'message', role: 'assistant', model: 'mm',
      content: [{ type: 'text', text: 'x' }],
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }
    const len = translateMessagesToChatBody({ ...base, stop_reason: 'max_tokens' } as unknown as MessagesResponse)
    expect(len.choices[0]?.finish_reason).toBe('length')
    const cf = translateMessagesToChatBody({ ...base, stop_reason: 'refusal' } as unknown as MessagesResponse)
    expect(cf.choices[0]?.finish_reason).toBe('content_filter')
  })

  it('totals usage including cache_read_input_tokens with prompt_tokens_details.cached_tokens', () => {
    const resp = {
      id: 'msg_c', type: 'message', role: 'assistant', model: 'mm',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    } as unknown as MessagesResponse
    const out = translateMessagesToChatBody(resp)
    // prompt = input + cache_read + cache_creation
    expect(out.usage.prompt_tokens).toBe(15)
    expect(out.usage.completion_tokens).toBe(5)
    expect(out.usage.total_tokens).toBe(20)
    expect(out.usage.prompt_tokens_details).toEqual({ cached_tokens: 3 })
  })
})
