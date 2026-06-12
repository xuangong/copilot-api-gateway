import { describe, test, expect } from 'bun:test'
import { translateResponsesToChatSSE } from '../../src/chat-completions-via-responses/index.ts'

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

async function* feed(items: unknown[]): AsyncIterable<unknown> {
  for (const i of items) yield i
}

describe('translateResponsesToChatSSE', () => {
  test('text-only response emits assistant role + content + finish:stop', async () => {
    const events = [
      { type: 'response.created', response: { id: 'r1', model: 'gpt-x', created_at: 1 } },
      { type: 'response.output_text.delta', delta: 'hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      { type: 'response.completed', response: { id: 'r1', status: 'completed' } },
    ]
    const chunks = await collect(translateResponsesToChatSSE(feed(events))) as Array<{
      choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>
      id: string; model: string
    }>
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' })
    expect(chunks[0].id).toBe('r1')
    expect(chunks[0].model).toBe('gpt-x')
    expect(chunks[1].choices[0].delta).toEqual({ content: 'hel' })
    expect(chunks[2].choices[0].delta).toEqual({ content: 'lo' })
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('stop')
  })

  test('function_call streams id+name first, then incremental arguments, finish:tool_calls', async () => {
    const events = [
      { type: 'response.created', response: { id: 'r2', model: 'm', created_at: 2 } },
      { type: 'response.output_item.added', output_index: 0,
        item: { type: 'function_call', call_id: 'call_a', name: 'f', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"x":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' },
      { type: 'response.completed', response: { id: 'r2', status: 'completed' } },
    ]
    const chunks = await collect(translateResponsesToChatSSE(feed(events))) as Array<{
      choices: Array<{ delta: { tool_calls?: Array<{ index: number; id?: string; type?: string; function: { name?: string; arguments?: string } }> }; finish_reason: string | null }>
    }>
    const added = chunks.find((c) => c.choices[0].delta.tool_calls?.[0]?.id === 'call_a')!
    expect(added.choices[0].delta.tool_calls![0]).toEqual({
      index: 0, id: 'call_a', type: 'function', function: { name: 'f', arguments: '' },
    })
    const argDeltas = chunks.filter((c) =>
      c.choices[0].delta.tool_calls && c.choices[0].delta.tool_calls[0].id === undefined,
    )
    expect(argDeltas[0].choices[0].delta.tool_calls![0]).toEqual({ index: 0, function: { arguments: '{"x":' } })
    expect(argDeltas[1].choices[0].delta.tool_calls![0]).toEqual({ index: 0, function: { arguments: '1}' } })
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('tool_calls')
  })

  test('length stop_reason → finish_reason:length', async () => {
    const events = [
      { type: 'response.created', response: { id: 'r', model: 'm', created_at: 3 } },
      { type: 'response.output_text.delta', delta: 'x' },
      { type: 'response.completed', response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
    ]
    const chunks = await collect(translateResponsesToChatSSE(feed(events))) as Array<{ choices: Array<{ finish_reason: string | null }> }>
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('length')
  })
})
