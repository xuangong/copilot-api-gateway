import { describe, it, expect } from 'bun:test'
import { translateResponsesToMessages } from '@vnext/translate/responses-via-messages'
import type { ResponsesPayload } from '@vnext/protocols/responses'

describe('responses-via-messages :: request', () => {
  it('translates string input into a single user message', () => {
    const p = { model: 'claude-3', input: 'hi' } as ResponsesPayload
    const out = translateResponsesToMessages(p)
    expect(out.target.model).toBe('claude-3')
    expect(out.target.max_tokens).toBe(8192) // default
    expect(out.target.messages.length).toBe(1)
    expect(out.target.messages[0]?.role).toBe('user')
    // last message has cache_control on the lone text block
    expect(out.target.messages[0]?.content).toEqual([
      { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } },
    ] as never)
  })

  it('translates message array with system/developer roles into separate system pieces', () => {
    const p = {
      model: 'claude',
      input: [
        { type: 'message', role: 'system', content: 'sys-A' },
        { type: 'message', role: 'developer', content: 'dev-B' },
        { type: 'message', role: 'user', content: 'hello' },
      ],
    } as ResponsesPayload
    const out = translateResponsesToMessages(p)
    // system blocks promoted with breakpoint
    expect(out.target.system).toEqual([
      { type: 'text', text: 'sys-A\n\ndev-B', cache_control: { type: 'ephemeral' } },
    ] as never)
    // user message present
    expect(out.target.messages[0]?.role).toBe('user')
  })

  it('combines instructions with system parts when both provided', () => {
    const p = {
      model: 'claude',
      instructions: 'INST',
      input: [
        { type: 'message', role: 'system', content: 'SYS' },
        { type: 'message', role: 'user', content: 'q' },
      ],
    } as ResponsesPayload
    const out = translateResponsesToMessages(p)
    expect((out.target.system as Array<{ text: string }>)[0]?.text).toBe('INST\n\nSYS')
  })

  it('expands input_text array into Anthropic text blocks', () => {
    const p = {
      model: 'm',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'one' },
            { type: 'input_text', text: 'two' },
          ],
        },
      ],
    } as unknown as ResponsesPayload
    const out = translateResponsesToMessages(p)
    expect(out.target.messages[0]?.content).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two', cache_control: { type: 'ephemeral' } },
    ] as never)
  })

  it('translates function_call into assistant tool_use and function_call_output into user tool_result', () => {
    const p = {
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: 'do' },
        { type: 'function_call', call_id: 'tu_1', name: 'fn', arguments: '{"x":1}' },
        { type: 'function_call_output', call_id: 'tu_1', output: 'ok' },
      ],
    } as unknown as ResponsesPayload
    const out = translateResponsesToMessages(p)
    expect(out.target.messages.length).toBe(3)
    expect(out.target.messages[0]?.role).toBe('user')
    expect(out.target.messages[1]?.role).toBe('assistant')
    expect((out.target.messages[1]?.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'tool_use', id: 'tu_1', name: 'fn', input: { x: 1 },
    })
    expect(out.target.messages[2]?.role).toBe('user')
    expect((out.target.messages[2]?.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'tool_result', tool_use_id: 'tu_1', content: 'ok',
    })
  })

  it('translates function tools into Anthropic tools and applies last-tool cache breakpoint', () => {
    const p = {
      model: 'm',
      input: 'hi',
      tools: [
        { type: 'function', name: 'web_lookup' },
        { type: 'function', name: 'calc', description: 'add', parameters: { type: 'object' } },
      ],
    } as unknown as ResponsesPayload
    const out = translateResponsesToMessages(p)
    expect(out.target.tools?.length).toBe(2)
    expect(out.target.tools?.[0]).toMatchObject({ name: 'web_lookup' })
    expect(out.target.tools?.[1]).toMatchObject({ name: 'calc', description: 'add' })
    // last tool gets breakpoint
    expect((out.target.tools?.[1] as { cache_control?: unknown })?.cache_control).toEqual({ type: 'ephemeral' })
    expect((out.target.tools?.[0] as { cache_control?: unknown })?.cache_control).toBeUndefined()
  })

  it('translates string and named tool_choice variants', () => {
    const auto = translateResponsesToMessages({ model: 'm', input: 'hi', tool_choice: 'auto' } as unknown as ResponsesPayload)
    const required = translateResponsesToMessages({ model: 'm', input: 'hi', tool_choice: 'required' } as unknown as ResponsesPayload)
    const none = translateResponsesToMessages({ model: 'm', input: 'hi', tool_choice: 'none' } as unknown as ResponsesPayload)
    const named = translateResponsesToMessages({
      model: 'm', input: 'hi',
      tool_choice: { type: 'function', name: 'fn' },
    } as unknown as ResponsesPayload)
    expect((auto.target as unknown as { tool_choice?: unknown }).tool_choice).toEqual({ type: 'auto' })
    expect((required.target as unknown as { tool_choice?: unknown }).tool_choice).toEqual({ type: 'any' })
    expect((none.target as unknown as { tool_choice?: unknown }).tool_choice).toEqual({ type: 'none' })
    expect((named.target as unknown as { tool_choice?: unknown }).tool_choice).toEqual({ type: 'tool', name: 'fn' })
  })

  it('builds output_config from reasoning effort + structured json_schema', () => {
    const p = {
      model: 'm',
      input: 'hi',
      reasoning: { effort: 'high' },
      text: { format: { type: 'json_schema', schema: { type: 'object' } } },
    } as unknown as ResponsesPayload
    const out = translateResponsesToMessages(p)
    expect((out.target as unknown as { output_config?: unknown }).output_config).toEqual({
      effort: 'high',
      format: { type: 'json_schema', schema: { type: 'object' } },
    } as never)
  })

  it('forwards temperature/top_p/max_output_tokens', () => {
    const p = {
      model: 'm', input: 'hi',
      max_output_tokens: 32, temperature: 0.7, top_p: 0.95,
    } as ResponsesPayload
    const out = translateResponsesToMessages(p)
    expect(out.target.max_tokens).toBe(32)
    expect((out.target as unknown as { temperature?: number }).temperature).toBe(0.7)
    expect((out.target as unknown as { top_p?: number }).top_p).toBe(0.95)
  })
})
