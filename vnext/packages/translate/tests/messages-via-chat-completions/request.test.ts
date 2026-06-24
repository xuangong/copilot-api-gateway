import { describe, it, expect } from 'bun:test'
import { translateMessagesToChat } from '@vnext/translate/messages-via-chat-completions'
import type { MessagesPayload } from '@vnext-llm/protocols/messages'

describe('messages-via-chat-completions :: request', () => {
  it('translates a string-only user message to a Chat user with string content', () => {
    const p = {
      model: 'gpt-4o', max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    } as MessagesPayload
    const out = translateMessagesToChat(p)
    expect(out.model).toBe('gpt-4o')
    expect(out.max_tokens).toBe(100)
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(out.stream).toBe(true) // default
  })

  it('flattens text-only blocks into a single string', () => {
    const p = {
      model: 'gpt', max_tokens: 50,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ] }],
    } as unknown as MessagesPayload
    const out = translateMessagesToChat(p)
    expect(out.messages[0]?.content).toBe('one\n\ntwo')
  })

  it('keeps mixed text+image as parts array with image_url URLs', () => {
    const p = {
      model: 'gpt', max_tokens: 1,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'see' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'image', source: { type: 'url', url: 'https://x/img.png' } },
      ] }],
    } as unknown as MessagesPayload
    const out = translateMessagesToChat(p)
    expect(out.messages[0]?.content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'https://x/img.png' } },
    ] as never)
  })

  it('emits role=tool messages for tool_result blocks', () => {
    const p = {
      model: 'gpt', max_tokens: 1,
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'result follows' },
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
        ] },
      ],
    } as unknown as MessagesPayload
    const out = translateMessagesToChat(p)
    expect(out.messages.length).toBe(2)
    expect(out.messages[0]).toEqual({ role: 'user', content: 'result follows' })
    expect(out.messages[1]).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: 'ok' })
  })

  it('translates assistant tool_use blocks into Chat tool_calls (and string content)', () => {
    const p = {
      model: 'gpt', max_tokens: 1,
      messages: [
        { role: 'assistant', content: [
          { type: 'text', text: 'calling' },
          { type: 'tool_use', id: 'tu_1', name: 'fn', input: { x: 1 } },
        ] },
      ],
    } as unknown as MessagesPayload
    const out = translateMessagesToChat(p)
    expect(out.messages[0]?.content).toBe('calling')
    expect(out.messages[0]?.tool_calls).toEqual([
      { id: 'tu_1', type: 'function', function: { name: 'fn', arguments: '{"x":1}' } },
    ])
  })

  it('translates system into a system message and joins block-form system text', () => {
    const p = {
      model: 'gpt', max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] as never,
    } as MessagesPayload
    const out = translateMessagesToChat(p)
    expect(out.messages[0]).toEqual({ role: 'system', content: 'A\n\nB' })
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('filters non-client tools and translates tool_choice variants', () => {
    const p = {
      model: 'gpt', max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'web_search', type: 'web_search_v1' } as never,
        { name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } } as never,
      ],
      tool_choice: { type: 'tool', name: 'lookup' } as never,
    } as MessagesPayload
    const out = translateMessagesToChat(p)
    expect(out.tools?.length).toBe(1)
    expect(out.tools?.[0]).toEqual({
      type: 'function',
      function: { name: 'lookup', description: undefined, parameters: { type: 'object', properties: { q: { type: 'string' } } } },
    })
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'lookup' } })
  })

  it('maps thinking budget_tokens → reasoning_effort buckets', () => {
    const mk = (b: number) => ({
      model: 'gpt', max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: b } as never,
    }) as MessagesPayload
    expect(translateMessagesToChat(mk(1024)).reasoning_effort).toBe('low')
    expect(translateMessagesToChat(mk(4096)).reasoning_effort).toBe('medium')
    expect(translateMessagesToChat(mk(16384)).reasoning_effort).toBe('high')
  })

  it('forwards stop_sequences as stop and temperature/top_p', () => {
    const p = {
      model: 'gpt', max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      stop_sequences: ['END'],
      temperature: 0.4,
      top_p: 0.9,
    } as MessagesPayload
    const out = translateMessagesToChat(p)
    expect(out.stop).toEqual(['END'])
    expect(out.temperature).toBe(0.4)
    expect(out.top_p).toBe(0.9)
  })
})
