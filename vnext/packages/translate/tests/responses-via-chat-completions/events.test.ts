import { describe, test, expect } from 'bun:test'
import { translateChatToResponsesEvents } from '../../src/responses-via-chat-completions/index.ts'

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}
async function* feed(items: unknown[]): AsyncIterable<unknown> {
  for (const i of items) yield i
}

describe('translateChatToResponsesEvents', () => {
  test('text-only stream emits created → message added → text deltas → completed', async () => {
    const chunks = [
      { id: 'r1', model: 'm', created: 1, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'r1', model: 'm', created: 1, choices: [{ index: 0, delta: { content: 'hel' }, finish_reason: null }] },
      { id: 'r1', model: 'm', created: 1, choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
      { id: 'r1', model: 'm', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
    const events = await collect(translateChatToResponsesEvents(feed(chunks))) as Array<{ type: string; delta?: string; response?: { id?: string; status?: string }; item?: { type?: string } }>
    expect(events[0].type).toBe('response.created')
    expect(events[0].response?.id).toBe('r1')
    expect(events[1].type).toBe('response.output_item.added')
    expect(events[1].item?.type).toBe('message')
    expect(events[2].type).toBe('response.output_text.delta')
    expect(events[2].delta).toBe('hel')
    expect(events[3].type).toBe('response.output_text.delta')
    expect(events[3].delta).toBe('lo')
    expect(events.at(-2)?.type).toBe('response.output_item.done')
    expect(events.at(-1)?.type).toBe('response.completed')
    expect(events.at(-1)?.response?.status).toBe('completed')
  })

  test('tool_calls: added → arguments delta → done → completed', async () => {
    const chunks = [
      { id: 'r2', model: 'm', created: 1, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'r2', model: 'm', created: 1, choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'f', arguments: '' } }],
      }, finish_reason: null }] },
      { id: 'r2', model: 'm', created: 1, choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }],
      }, finish_reason: null }] },
      { id: 'r2', model: 'm', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]
    const events = await collect(translateChatToResponsesEvents(feed(chunks))) as Array<{ type: string; item?: { type?: string; call_id?: string; name?: string }; delta?: string; response?: { status?: string } }>
    const added = events.find((e) => e.type === 'response.output_item.added' && e.item?.type === 'function_call')!
    expect(added.item?.call_id).toBe('call_a')
    expect(added.item?.name).toBe('f')
    const argDelta = events.find((e) => e.type === 'response.function_call_arguments.delta')!
    expect(argDelta.delta).toBe('{"x":1}')
    expect(events.at(-1)?.response?.status).toBe('completed')
  })

  test('finish:length → incomplete with reason', async () => {
    const chunks = [
      { id: 'r3', model: 'm', created: 1, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'r3', model: 'm', created: 1, choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] },
      { id: 'r3', model: 'm', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
    ]
    const events = await collect(translateChatToResponsesEvents(feed(chunks))) as Array<{ type: string; response?: { status?: string; incomplete_details?: { reason?: string } } }>
    const completed = events.at(-1)!
    expect(completed.type).toBe('response.completed')
    expect(completed.response?.status).toBe('incomplete')
    expect(completed.response?.incomplete_details?.reason).toBe('max_output_tokens')
  })

  test('cancellation: consumer breaking early runs upstream finally', async () => {
    let upstreamClosed = false
    async function* upstream(): AsyncGenerator<unknown> {
      try {
        yield { id: 'r', model: 'm', created: 1, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }
        for (let i = 0; i < 100; i++) {
          yield { id: 'r', model: 'm', created: 1, choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] }
        }
      } finally {
        upstreamClosed = true
      }
    }
    const it = translateChatToResponsesEvents(upstream())
    let count = 0
    for await (const _ of it) {
      count++
      if (count >= 3) break
    }
    expect(upstreamClosed).toBe(true)
    expect(count).toBe(3)
  })
})
