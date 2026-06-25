import { describe, it, expect } from 'bun:test'
import { translateChatBodyToMessages } from '@vibe-llm/translate/messages-via-chat-completions'

describe('messages-via-chat-completions :: body', () => {
  it('expands content + tool_calls + reasoning_text into Anthropic content blocks', () => {
    const resp = {
      id: 'chatcmpl_x',
      model: 'gpt-4o',
      choices: [{
        message: {
          role: 'assistant',
          content: 'Calling…',
          reasoning_text: 'thoughts',
          tool_calls: [{ id: 'tu_1', type: 'function' as const, function: { name: 'fn', arguments: '{"x":1}' } }],
        },
        finish_reason: 'tool_calls' as const,
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } },
    }
    const out = translateChatBodyToMessages(resp)
    expect(out.id).toBe('chatcmpl_x')
    expect(out.model).toBe('gpt-4o')
    expect(out.content).toEqual([
      { type: 'thinking', thinking: 'thoughts' },
      { type: 'text', text: 'Calling…' },
      { type: 'tool_use', id: 'tu_1', name: 'fn', input: { x: 1 } },
    ] as never)
    expect(out.stop_reason).toBe('tool_use')
    // input = prompt - cached
    expect(out.usage).toMatchObject({
      input_tokens: 7,
      output_tokens: 5,
      cache_read_input_tokens: 3,
    })
  })

  it('synthesizes message id and uses fallbackModel when missing', () => {
    const out = translateChatBodyToMessages(
      { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' as const }] },
      'gpt-4o-mini',
    )
    expect(out.id.startsWith('msg_')).toBe(true)
    expect(out.model).toBe('gpt-4o-mini')
    expect(out.stop_reason).toBe('end_turn')
  })

  it('maps finish_reason length → max_tokens, content_filter → refusal', () => {
    const a = translateChatBodyToMessages({ choices: [{ message: { content: 'x' }, finish_reason: 'length' as const }] })
    expect(a.stop_reason).toBe('max_tokens')
    const b = translateChatBodyToMessages({ choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' as const }] })
    expect(b.stop_reason).toBe('refusal')
  })
})
