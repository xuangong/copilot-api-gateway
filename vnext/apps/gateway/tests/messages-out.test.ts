import { test, expect } from 'bun:test'
import { messagesOut } from '../src/data-plane/adapters/backend/messages-out.ts'
import type { IRRequest } from '@vnext/protocols/ir'

const meta = { flags: {}, binding: null, iteration: 0, privateState: {}, clientProtocol: 'messages' as const }

test('toUpstream concatenates system messages into top-level system field', () => {
  const req: IRRequest = {
    model: 'claude-3-5-sonnet-20241022',
    stream: false,
    max_output_tokens: 256,
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'system', content: 'no emojis' },
      { role: 'user', content: 'hi' },
    ],
    meta,
  }
  const out = messagesOut.toUpstream(req) as { model: string; max_tokens: number; system: string; messages: Array<{ role: string; content: unknown }> }
  expect(out.model).toBe('claude-3-5-sonnet-20241022')
  expect(out.max_tokens).toBe(256)
  expect(out.system).toContain('be terse')
  expect(out.system).toContain('no emojis')
  expect(out.messages).toHaveLength(1)
  expect(out.messages[0]?.role).toBe('user')
})

test('toUpstream defaults max_tokens to 4096 when missing', () => {
  const req: IRRequest = {
    model: 'claude-3-5-sonnet-20241022',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
    meta,
  }
  const out = messagesOut.toUpstream(req) as { max_tokens: number }
  expect(out.max_tokens).toBe(4096)
})

test('toUpstream maps tool_use / tool_result content blocks', () => {
  const req: IRRequest = {
    model: 'claude-3-5-sonnet-20241022',
    stream: false,
    max_output_tokens: 64,
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', arguments: { city: 'sf' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', output: '72F' }] },
    ],
    tools: [{ type: 'function', name: 'get_weather', description: 'lookup', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'get_weather' },
    meta,
  }
  const out = messagesOut.toUpstream(req) as {
    messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    tools: Array<{ name: string; description?: string; input_schema?: unknown }>
    tool_choice: { type: string; name?: string }
  }
  expect(out.tools[0]?.name).toBe('get_weather')
  expect(out.tools[0]?.input_schema).toEqual({ type: 'object' })
  expect(out.tool_choice).toEqual({ type: 'tool', name: 'get_weather' })
  expect(out.messages[1]?.content[0]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'sf' } })
  expect(out.messages[2]?.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_1', content: '72F' })
})
