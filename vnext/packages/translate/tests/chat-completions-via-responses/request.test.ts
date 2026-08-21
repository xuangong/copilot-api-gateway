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

  describe('hosted web search', () => {
    // Chat Completions triggers search with top-level `web_search_options`,
    // Responses with a `tools[]` entry. Every `gpt-5*` on Copilot is served
    // only on /responses, so without this bridge the dashboard's 联网搜索
    // toggle is a no-op for those models.
    test('maps web_search_options onto a hosted web_search tool', () => {
      const out = translateChatToResponses({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'weather' }],
        web_search_options: {},
      } as never)
      expect(out.target.tools).toEqual([{ type: 'web_search' }] as never)
    })

    test('forwards search_context_size and user_location, keeping client tools first', () => {
      const location = { type: 'approximate', approximate: { city: 'Beijing' } }
      const out = translateChatToResponses({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'weather' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        web_search_options: { search_context_size: 'high', user_location: location },
      } as never)
      const tools = out.target.tools as Array<{ type: string; name?: string }>
      expect(tools.map((t) => t.name ?? t.type)).toEqual(['lookup', 'web_search'])
      // Responses has both knobs natively, so unlike the Messages pair they survive.
      expect(tools[1]).toEqual({
        type: 'web_search',
        search_context_size: 'high',
        user_location: location,
      } as never)
    })

    test('leaves tools untouched when search was not requested', () => {
      const out = translateChatToResponses({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
      } as never)
      expect(out.target.tools).toBeUndefined()
      expect((out.target as { include?: unknown }).include).toBeUndefined()
    })

    // The gateway's web-search shim gates `web_search_call.results` on the
    // Responses-only `include` opt-in, mirroring native Responses. A Chat
    // Completions client has no way to spell that token, so requesting search
    // is taken as requesting its sources.
    test('opts into web_search_call.results so sources reach the client', () => {
      const out = translateChatToResponses({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'weather' }],
        web_search_options: {},
      } as never)
      expect((out.target as { include?: unknown }).include).toEqual(['web_search_call.results'])
    })

    test('does not duplicate the token when the caller already sent include', () => {
      const out = translateChatToResponses({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'weather' }],
        web_search_options: {},
        include: ['web_search_call.results', 'reasoning.encrypted_content'],
      } as never)
      expect((out.target as { include?: unknown }).include)
        .toEqual(['web_search_call.results', 'reasoning.encrypted_content'])
    })
  })
})
