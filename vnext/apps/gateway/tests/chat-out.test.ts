import { test, expect } from 'bun:test'
import { chatOut } from '../src/data-plane/adapters/backend/chat-out.ts'
import type { IRRequest } from '@vnext/protocols/ir'

const meta = { flags: {}, binding: null, iteration: 0, privateState: {}, clientProtocol: 'chat_completions' as const }

test('toUpstream maps text messages + max_output_tokens → max_tokens', () => {
  const req: IRRequest = {
    model: 'gpt-4o-mini',
    stream: false,
    max_output_tokens: 64,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
    ],
    meta,
  }
  const out = chatOut.toUpstream(req) as { model: string; stream: boolean; max_tokens: number; temperature: number; messages: Array<{ role: string; content: string }> }
  expect(out.model).toBe('gpt-4o-mini')
  expect(out.stream).toBe(false)
  expect(out.max_tokens).toBe(64)
  expect(out.temperature).toBe(0.2)
  expect(out.messages).toEqual([
    { role: 'system', content: 'you are helpful' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ])
})

test('toUpstream maps tool_use → assistant.tool_calls and tool_result → role:"tool"', () => {
  const req: IRRequest = {
    model: 'gpt-4o-mini',
    stream: false,
    messages: [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', arguments: { city: 'sf' } }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', output: '72F' }],
      },
    ],
    tools: [{ type: 'function', name: 'get_weather', description: 'lookup', parameters: { type: 'object' } }],
    tool_choice: 'auto',
    meta,
  }
  const out = chatOut.toUpstream(req) as {
    messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>
    tools: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>
    tool_choice: string
  }
  expect(out.tools[0]?.type).toBe('function')
  expect(out.tools[0]?.function.name).toBe('get_weather')
  expect(out.tool_choice).toBe('auto')
  const asst = out.messages[1]
  expect(asst?.role).toBe('assistant')
  expect(asst?.content).toBeNull()
  expect(asst?.tool_calls?.[0]?.id).toBe('call_1')
  expect(asst?.tool_calls?.[0]?.function.name).toBe('get_weather')
  expect(JSON.parse(asst?.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({ city: 'sf' })
  const tool = out.messages[2]
  expect(tool?.role).toBe('tool')
  expect(tool?.tool_call_id).toBe('call_1')
  expect(tool?.content).toBe('72F')
})

test('toUpstream translates structured tool_choice', () => {
  const req: IRRequest = {
    model: 'gpt-4o-mini',
    stream: false,
    messages: [{ role: 'user', content: 'go' }],
    tool_choice: { type: 'function', name: 'do_it' },
    meta,
  }
  const out = chatOut.toUpstream(req) as { tool_choice: { type: string; function: { name: string } } }
  expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'do_it' } })
})
