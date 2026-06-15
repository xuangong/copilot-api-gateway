import { test, expect } from 'bun:test'
import { reassembleChatCompletions } from '../../../../../src/data-plane/chat-flow/chat-completions/events/reassemble'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'

const drainable = async function* (events: ChatCompletionsStreamEvent[]) { for (const e of events) yield e }

test('concatenates content deltas into a single message', async () => {
  const result = await reassembleChatCompletions(drainable([
    { id: 'c1', object: 'chat.completion.chunk', model: 'gpt-x', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] } as any,
    { id: 'c1', object: 'chat.completion.chunk', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] } as any,
  ]))
  expect(result.choices[0]!.message.content).toBe('Hello')
  expect(result.choices[0]!.finish_reason).toBe('stop')
})

test('aggregates tool_calls sorted by index with concatenated arguments', async () => {
  const result = await reassembleChatCompletions(drainable([
    { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'foo', arguments: '{"a":' } }] } }] } as any,
    { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] } as any,
  ]))
  expect(result.choices[0]!.message.tool_calls?.[0]!.function.arguments).toBe('{"a":1}')
  expect(result.choices[0]!.finish_reason).toBe('tool_calls')
})

test('lifts last usage chunk to top-level usage', async () => {
  const result = await reassembleChatCompletions(drainable([
    { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] } as any,
    { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } } as any,
  ]))
  expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 })
})

test('throws on upstream error payload chunk', async () => {
  await expect(reassembleChatCompletions(drainable([
    { error: { message: 'upstream failed' } } as any,
  ]))).rejects.toThrow(/upstream failed/)
})
