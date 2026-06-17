import { describe, it, expect } from 'bun:test'
import { translateChatToMessages } from '@vnext/translate/chat-completions-via-messages'
import { EPHEMERAL_CACHE_CONTROL } from '@vnext/translate/shared/cache-breakpoints'
import { TranslatorValidationError } from '@vnext/translate/errors'

describe('chat-completions-via-messages :: request', () => {
  it('translates a minimal text-only chat payload to a Messages payload', () => {
    const out = translateChatToMessages({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'user', content: 'hello' },
      ],
      max_tokens: 256,
    })
    expect(out.model).toBe('claude-3-5-sonnet')
    expect(out.max_tokens).toBe(256)
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]?.role).toBe('user')
    // last user message is text -> string is promoted to a single text block
    // with cache breakpoint applied.
    const blocks = out.messages[0]?.content as Array<{ type: string; text?: string; cache_control?: unknown }>
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks[0]).toEqual({
      type: 'text',
      text: 'hello',
      cache_control: EPHEMERAL_CACHE_CONTROL,
    })
  })

  it('moves system messages out into a system block with cache breakpoint', () => {
    const out = translateChatToMessages({
      model: 'm',
      messages: [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 64,
    })
    expect(out.system).toEqual([
      { type: 'text', text: 'be helpful', cache_control: EPHEMERAL_CACHE_CONTROL },
    ])
  })

  it('falls back to default max_tokens when omitted', () => {
    const out = translateChatToMessages({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    } as never, { fallbackMaxOutputTokens: 1234 })
    expect(out.max_tokens).toBe(1234)
  })

  it('translates image_url content into an Anthropic image block', () => {
    const out = translateChatToMessages({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see this' },
            { type: 'image_url', image_url: { url: 'https://x/y.png' } },
          ],
        },
      ],
      max_tokens: 1,
    })
    const blocks = out.messages[0]?.content as Array<{ type: string; source?: { type: string; url?: string } }>
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'see this' })
    expect(blocks[1]).toMatchObject({ type: 'image', source: { type: 'url', url: 'https://x/y.png' } })
  })

  it('translates data: image_url into a base64 image block', () => {
    const out = translateChatToMessages({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
          ],
        },
      ],
      max_tokens: 1,
    })
    const blocks = out.messages[0]?.content as Array<{ type: string; source?: { type: string; media_type?: string; data?: string } }>
    expect(blocks[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAA=' },
    })
  })

  it('translates assistant tool_calls into tool_use blocks and tool messages into tool_result', () => {
    const out = translateChatToMessages({
      model: 'm',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'sure',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'do', arguments: '{"x":1}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'done' },
      ],
      max_tokens: 1,
    })
    expect(out.messages[1]?.role).toBe('assistant')
    const a = out.messages[1]?.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
    expect(a[0]).toMatchObject({ type: 'text', text: 'sure' })
    expect(a[1]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'do', input: { x: 1 } })

    expect(out.messages[2]?.role).toBe('user')
    const tr = out.messages[2]?.content as Array<{ type: string; tool_use_id?: string; content?: string }>
    expect(tr[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: 'done' })
  })

  it('translates Chat tool definitions to Messages tools with cache breakpoint on the last one', () => {
    const out = translateChatToMessages({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      max_tokens: 1,
      tools: [
        { type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'b', description: 'B' } },
      ],
    })
    expect(out.tools).toHaveLength(2)
    expect((out.tools as Array<{ name: string; cache_control?: unknown }>)[0]).toMatchObject({ name: 'a' })
    expect((out.tools as Array<{ name: string; cache_control?: unknown }>)[1]).toMatchObject({
      name: 'b',
      cache_control: EPHEMERAL_CACHE_CONTROL,
    })
  })

  it('maps tool_choice "required" → "any", "auto" → "auto", named function → tool', () => {
    const r1 = translateChatToMessages({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 1, tool_choice: 'required' })
    expect(r1.tool_choice).toEqual({ type: 'any' })
    const r2 = translateChatToMessages({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 1, tool_choice: 'auto' })
    expect(r2.tool_choice).toEqual({ type: 'auto' })
    const r3 = translateChatToMessages({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 1, tool_choice: { type: 'function', function: { name: 'fn' } } as never })
    expect(r3.tool_choice).toEqual({ type: 'tool', name: 'fn' })
  })

  it('passes through temperature/top_p and converts string stop into stop_sequences', () => {
    const out = translateChatToMessages({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1,
      temperature: 0.7,
      top_p: 0.9,
      stop: 'STOP',
    })
    expect(out.temperature).toBe(0.7)
    expect(out.top_p).toBe(0.9)
    expect(out.stop_sequences).toEqual(['STOP'])
  })

  it('maps reasoning_effort=low/medium/high/xhigh to thinking budgets', () => {
    for (const [effort, budget] of [
      ['low', 1024],
      ['medium', 4096],
      ['high', 16384],
      ['xhigh', 32768],
    ] as const) {
      const out = translateChatToMessages({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 1,
        reasoning_effort: effort,
      })
      expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: budget })
    }
  })

  it('omits thinking when reasoning_effort is missing', () => {
    const out = translateChatToMessages({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1,
    })
    expect(out.thinking).toBeUndefined()
  })

  it('throws TranslatorValidationError when tool message is missing tool_call_id', () => {
    expect(() =>
      translateChatToMessages({
        model: 'm',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'tool', content: 'result' } as never,
        ],
        max_tokens: 1,
      }),
    ).toThrow(TranslatorValidationError)
  })
})
