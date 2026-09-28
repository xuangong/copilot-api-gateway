import { describe, test, expect } from 'bun:test'
import { translateChatToResponsesBody } from '../../src/responses-via-chat-completions/index.ts'

describe('translateChatToResponsesBody', () => {
  test('text-only chat completion → responses with output_text item', () => {
    const out = translateChatToResponsesBody({
      id: 'c1', model: 'm', created: 100,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }) as {
      id: string
      model: string
      created_at: number
      status: string
      output: Array<{ type: string; id?: string; status?: string; role?: string; content?: Array<{ type: string; text: string; annotations: unknown[] }> }>
      output_text: string
      error: null
      incomplete_details: null
      instructions: unknown
      metadata: unknown
      parallel_tool_calls: boolean
      tool_choice: unknown
      tools: unknown
      temperature: unknown
      top_p: unknown
      usage: { input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details: { cached_tokens: number }; output_tokens_details: { reasoning_tokens: number } }
    }
    expect(out.id).toBe('c1')
    expect(out.created_at).toBe(100)
    expect(out.status).toBe('completed')
    expect(out.output_text).toBe('hi')
    expect(out.error).toBeNull()
    expect(out.incomplete_details).toBeNull()
    expect(out.instructions).toBeNull()
    expect(out.metadata).toBeNull()
    expect(out.parallel_tool_calls).toBe(true)
    expect(out.tool_choice).toBe('auto')
    expect(out.tools).toEqual([])
    expect(out.temperature).toBeNull()
    expect(out.top_p).toBeNull()
    const item = out.output[0]
    expect(item.type).toBe('message')
    expect(typeof item.id).toBe('string')
    expect(item.id?.startsWith('msg_')).toBe(true)
    expect(item.status).toBe('completed')
    expect(item.role).toBe('assistant')
    expect(item.content).toEqual([{ type: 'output_text', text: 'hi', annotations: [] }])
    expect(out.usage).toEqual({
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 4,
    })
  })

  test('tool_calls produce function_call output items', () => {
    const out = translateChatToResponsesBody({
      id: 'c2', model: 'm', created: 1,
      choices: [{ index: 0, message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }],
      }, finish_reason: 'tool_calls' }],
    }) as { output: Array<{ type: string; call_id?: string; name?: string; arguments?: string; status?: string }> }
    expect(out.output).toEqual([
      { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '{"x":1}', status: 'completed' },
    ] as never)
  })

  test.each(['tool_calls', 'length'] as const)('JSON ordinary and custom tool statuses follow %s', finish_reason => {
    const out = translateChatToResponsesBody({
      id: 'r', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [
        { id: 'custom_id', type: 'function', function: { name: 'execute', arguments: '{"input":"yes"}' } },
        { id: 'function_id', type: 'function', function: { name: 'ordinary', arguments: '{"x":1}' } },
      ] }, finish_reason }],
    }, { customToolNames: ['execute'] })
    const status = finish_reason === 'length' ? 'incomplete' : 'completed'
    expect(out.status).toBe(status)
    expect(out.output).toMatchObject([
      { type: 'custom_tool_call', call_id: 'custom_id', name: 'execute', input: 'yes', status },
      { type: 'function_call', call_id: 'function_id', name: 'ordinary', arguments: '{"x":1}', status },
    ])
  })

  test('finish:length → status:incomplete', () => {
    const out = translateChatToResponsesBody({
      id: 'c3', model: 'm', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'length' }],
    }) as { status: string; incomplete_details: { reason: string } | null }
    expect(out.status).toBe('incomplete')
    expect(out.incomplete_details?.reason).toBe('max_output_tokens')
  })

  test('sourcePayload echoes instructions/metadata/tool_choice/tools/top_p/temperature/parallel_tool_calls', () => {
    const out = translateChatToResponsesBody(
      {
        id: 'c4', model: 'm', created: 1,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      },
      {
        sourcePayload: {
          instructions: 'be concise',
          metadata: { trace: 'abc' },
          parallel_tool_calls: false,
          temperature: 0.4,
          tool_choice: 'required',
          tools: [{ type: 'function', name: 'f' }],
          top_p: 0.9,
        },
      },
    ) as {
      instructions: unknown
      metadata: unknown
      parallel_tool_calls: boolean
      temperature: unknown
      tool_choice: unknown
      tools: unknown
      top_p: unknown
    }
    expect(out.instructions).toBe('be concise')
    expect(out.metadata).toEqual({ trace: 'abc' })
    expect(out.parallel_tool_calls).toBe(false)
    expect(out.temperature).toBe(0.4)
    expect(out.tool_choice).toBe('required')
    expect(out.tools).toEqual([{ type: 'function', name: 'f' }])
    expect(out.top_p).toBe(0.9)
  })
})
