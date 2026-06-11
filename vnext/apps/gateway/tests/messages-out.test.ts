import { test, expect } from 'bun:test'
import { messagesOut } from '../src/data-plane/adapters/backend/messages-out.ts'
import type { IRRequest, IREvent } from '@vnext/protocols/ir'

const meta = { flags: {}, binding: null, iteration: 0, privateState: {}, clientProtocol: 'messages' as const }

async function collect(iter: AsyncIterable<IREvent>): Promise<IREvent[]> {
  const out: IREvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

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

test('decodeBody maps Anthropic message → created/text/tool_call/completed', async () => {
  const body = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'thinking…' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'sf' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 11, output_tokens: 7 },
  }
  const events = await collect(messagesOut.decodeBody(body))
  expect(events[0]).toEqual({ type: 'response.created', response: { id: 'msg_1' } })
  const delta = events.find((e) => e.type === 'response.output_text.delta') as Extract<IREvent, { type: 'response.output_text.delta' }>
  expect(delta.delta).toBe('thinking…')
  const tc = events.find((e) => e.type === 'response.tool_call.completed') as Extract<IREvent, { type: 'response.tool_call.completed' }>
  expect(tc.itemId).toBe('toolu_1')
  expect(tc.name).toBe('get_weather')
  expect(tc.arguments).toEqual({ city: 'sf' })
  const done = events[events.length - 1] as Extract<IREvent, { type: 'response.completed' }>
  expect(done.response.finish_reason).toBe('tool_use')
  expect(done.response.usage?.input_tokens).toBe(11)
  expect(done.response.usage?.output_tokens).toBe(7)
})

