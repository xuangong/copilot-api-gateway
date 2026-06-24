import { describe, it, expect } from 'bun:test'
import { translateResponsesToMessagesBody } from '@vnext-llm/translate/messages-via-responses'

interface ResponsesResultLike {
  id: string
  model: string
  status?: string
  incomplete_details?: { reason?: string } | null
  output: Array<Record<string, unknown>>
  output_text?: string
  usage?: Record<string, unknown>
}

describe('messages-via-responses :: body', () => {
  it('collapses output[] into Anthropic content[] (reasoning → thinking, message → text, function_call → tool_use)', () => {
    const resp: ResponsesResultLike = {
      id: 'resp_1',
      model: 'gpt-5',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ text: 'pondering' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
        { type: 'function_call', call_id: 'tu_1', name: 'fn', arguments: '{"x":1}' },
      ],
      usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } },
    }
    const out = translateResponsesToMessagesBody(resp)
    expect(out.id).toBe('resp_1')
    expect(out.model).toBe('gpt-5')
    expect(out.role).toBe('assistant')
    expect(out.type).toBe('message')
    expect(out.content.length).toBe(3)
    expect(out.content[0]).toMatchObject({ type: 'thinking', thinking: 'pondering' })
    expect(out.content[1]).toMatchObject({ type: 'text', text: 'Hello' })
    expect(out.content[2]).toMatchObject({ type: 'tool_use', id: 'tu_1', name: 'fn', input: { x: 1 } })
    expect(out.stop_reason).toBe('tool_use')
    // input_tokens excludes the cached portion; cache_read_input_tokens carries it
    expect(out.usage.input_tokens).toBe(7) // 10 - 3
    expect(out.usage.output_tokens).toBe(4)
    expect(out.usage.cache_read_input_tokens).toBe(3)
  })

  it('falls back to output_text when output[] yields no content blocks', () => {
    const resp: ResponsesResultLike = {
      id: 'resp_2',
      model: 'gpt-5',
      status: 'completed',
      output: [],
      output_text: 'fallback',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    const out = translateResponsesToMessagesBody(resp)
    expect(out.content).toEqual([{ type: 'text', text: 'fallback' }] as never)
    expect(out.stop_reason).toBe('end_turn')
  })

  it('maps incomplete + max_output_tokens to stop_reason=max_tokens', () => {
    const resp: ResponsesResultLike = {
      id: 'resp_3',
      model: 'gpt-5',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
      usage: { input_tokens: 0, output_tokens: 1 },
    }
    const out = translateResponsesToMessagesBody(resp)
    expect(out.stop_reason).toBe('max_tokens')
  })

  it('parses raw_arguments wrapper when arguments is not valid JSON', () => {
    const resp: ResponsesResultLike = {
      id: 'r',
      model: 'm',
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'tu_x', name: 'fn', arguments: 'not-json' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }
    const out = translateResponsesToMessagesBody(resp)
    expect(out.content[0]).toMatchObject({
      type: 'tool_use', id: 'tu_x', name: 'fn',
      input: { raw_arguments: 'not-json' },
    })
  })
})
