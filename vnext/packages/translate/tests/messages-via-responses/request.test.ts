import { describe, it, expect } from 'bun:test'
import { translateMessagesToResponses } from '@vnext-llm/translate/messages-via-responses'
import type { MessagesPayload } from '@vnext-llm/protocols/messages'

describe('messages-via-responses :: request', () => {
  it('translates string user content into a single user message item', () => {
    const p: MessagesPayload = {
      model: 'gpt-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    }
    const out = translateMessagesToResponses(p)
    expect(out.target.model).toBe('gpt-5')
    expect(out.target.max_output_tokens).toBe(64)
    const input = out.target.input as Array<Record<string, unknown>>
    expect(input.length).toBe(1)
    expect(input[0]).toMatchObject({ type: 'message', role: 'user', content: 'hello' })
  })

  it('translates text + image blocks into input_text + input_image content parts', () => {
    const p: MessagesPayload = {
      model: 'm',
      max_tokens: 32,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          ],
        },
      ],
    } as unknown as MessagesPayload
    const out = translateMessagesToResponses(p)
    const input = out.target.input as Array<{ type: string; role?: string; content: unknown }>
    expect(input[0]?.role).toBe('user')
    expect(input[0]?.content).toEqual([
      { type: 'input_text', text: 'see this' },
      { type: 'input_image', text: 'data:image/png;base64,AAA' },
    ] as never)
  })

  it('translates assistant tool_use into a function_call item with call_id only and tool_result into function_call_output', () => {
    const p: MessagesPayload = {
      model: 'm',
      max_tokens: 16,
      messages: [
        { role: 'user', content: 'do' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_use', id: 'tu_1', name: 'fn', input: { x: 1 } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'done' }],
        },
      ],
    } as unknown as MessagesPayload
    const out = translateMessagesToResponses(p)
    const input = out.target.input as Array<Record<string, unknown>>
    // [user-msg, assistant-msg(text), function_call, function_call_output]
    expect(input.length).toBe(4)
    expect(input[0]).toMatchObject({ type: 'message', role: 'user', content: 'do' })
    expect(input[1]).toMatchObject({ type: 'message', role: 'assistant' })
    expect((input[1]?.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'output_text', text: 'ok',
    })
    expect(input[2]).toMatchObject({
      type: 'function_call', call_id: 'tu_1', name: 'fn', arguments: '{"x":1}',
    })
    // No `id` field set on the request side (upstream rejects non-`fc_` ids).
    expect((input[2] as { id?: unknown }).id).toBeUndefined()
    expect(input[3]).toMatchObject({ type: 'function_call_output', call_id: 'tu_1', output: 'done' })
  })

  it('promotes Messages system into Responses instructions (joins system block array with \\n\\n)', () => {
    const p: MessagesPayload = {
      model: 'm',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
      system: [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
      ],
    } as unknown as MessagesPayload
    const out = translateMessagesToResponses(p)
    expect(out.target.instructions).toBe('A\n\nB')
  })

  it('translates web_search server tool to hosted Responses tool and custom tools to Responses functions', () => {
    const p: MessagesPayload = {
      model: 'm',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'q' }],
      tools: [
        { type: 'web_search_20250305', name: 'web_search' },
        { name: 'calc', description: 'add', input_schema: { type: 'object' } },
      ],
    } as unknown as MessagesPayload
    const out = translateMessagesToResponses(p)
    const tools = out.target.tools as Array<Record<string, unknown>>
    expect(tools.length).toBe(2)
    expect(tools[0]).toEqual({ type: 'web_search' })
    expect(tools[1]).toMatchObject({ type: 'function', name: 'calc', description: 'add', strict: false })
    expect((tools[1] as { parameters?: unknown }).parameters).toEqual({ type: 'object' })
  })

  it('translates tool_choice variants (auto, any→required, named tool, none) and falls back to auto', () => {
    const base: MessagesPayload = {
      model: 'm', max_tokens: 8,
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ name: 'fn' }],
    } as unknown as MessagesPayload

    const auto = translateMessagesToResponses({ ...base, tool_choice: { type: 'auto' } } as MessagesPayload)
    expect(auto.target.tool_choice).toBe('auto')

    const required = translateMessagesToResponses({ ...base, tool_choice: { type: 'any' } } as MessagesPayload)
    expect(required.target.tool_choice).toBe('required')

    const named = translateMessagesToResponses({ ...base, tool_choice: { type: 'tool', name: 'fn' } } as MessagesPayload)
    expect(named.target.tool_choice).toEqual({ type: 'function', name: 'fn' })

    const none = translateMessagesToResponses({ ...base, tool_choice: { type: 'none' } } as MessagesPayload)
    expect(none.target.tool_choice).toBe('none')

    // unknown name falls back to auto
    const unknown = translateMessagesToResponses({ ...base, tool_choice: { type: 'tool', name: 'nope' } } as MessagesPayload)
    expect(unknown.target.tool_choice).toBe('auto')
  })

  it('maps thinking budget to reasoning effort when output_config.effort is absent', () => {
    const low = translateMessagesToResponses({
      model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'q' }],
      thinking: { budget_tokens: 1024 },
    } as unknown as MessagesPayload)
    expect(low.target.reasoning).toEqual({ effort: 'low' })

    const med = translateMessagesToResponses({
      model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'q' }],
      thinking: { budget_tokens: 4096 },
    } as unknown as MessagesPayload)
    expect(med.target.reasoning).toEqual({ effort: 'medium' })

    const high = translateMessagesToResponses({
      model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'q' }],
      thinking: { budget_tokens: 16384 },
    } as unknown as MessagesPayload)
    expect(high.target.reasoning).toEqual({ effort: 'high' })
  })

  it('prefers output_config.effort over thinking budget mapping', () => {
    const out = translateMessagesToResponses({
      model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'q' }],
      thinking: { budget_tokens: 1024 },
      output_config: { effort: 'xhigh' },
    } as unknown as MessagesPayload)
    expect(out.target.reasoning).toEqual({ effort: 'xhigh' })
  })

  it('translates output_config.format json_schema to Responses text.format', () => {
    const out = translateMessagesToResponses({
      model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'q' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    } as unknown as MessagesPayload)
    expect(out.target.text).toEqual({
      format: { type: 'json_schema', name: 'messages_response', strict: true, schema: { type: 'object' } },
    } as never)
  })

  it('forwards temperature/top_p/metadata/stream and defaults stream=true', () => {
    const out = translateMessagesToResponses({
      model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'q' }],
      temperature: 0.7, top_p: 0.95,
      metadata: { user_id: 'u1' },
    } as unknown as MessagesPayload)
    expect(out.target.temperature).toBe(0.7)
    expect(out.target.top_p).toBe(0.95)
    expect(out.target.metadata).toEqual({ user_id: 'u1' } as never)
    expect(out.target.stream).toBe(true)
  })
})
