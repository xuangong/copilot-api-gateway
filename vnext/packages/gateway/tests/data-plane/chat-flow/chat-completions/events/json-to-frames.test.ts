// vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/events/json-to-frames.test.ts
/**
 * Unit coverage for the JSON→protocol-frame bridge. The downstream contract is
 * "reassemble round-trips the same body" — if it doesn't, attempt.ts's non-
 * stream branch will surface a 200 body that differs from what the upstream
 * returned.
 */
import { test, expect } from 'bun:test'
import { synthesizeChatCompletionsFramesFromJson, type ChatCompletionsJsonBody } from '../../../../../src/data-plane/chat-flow/chat-completions/events/json-to-frames'
import { collectChatCompletionsProtocolEventsToResult } from '../../../../../src/data-plane/chat-flow/chat-completions/events/to-result'

test('synthesizes a single event-frame + done-frame for a minimal body', async () => {
  const body: ChatCompletionsJsonBody = {
    id: 'cc_1',
    object: 'chat.completion',
    created: 100,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  }
  const frames = []
  for await (const f of synthesizeChatCompletionsFramesFromJson(body)) frames.push(f)
  expect(frames).toHaveLength(2)
  expect(frames[0]!.type).toBe('event')
  expect(frames[1]!.type).toBe('done')
})

test('round-trips through reassemble back to an equivalent ChatCompletionsResult', async () => {
  const body: ChatCompletionsJsonBody = {
    id: 'cc_2',
    object: 'chat.completion',
    created: 200,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from upstream' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  }
  const result = await collectChatCompletionsProtocolEventsToResult(
    synthesizeChatCompletionsFramesFromJson(body),
  )
  expect(result.id).toBe('cc_2')
  expect(result.model).toBe('gpt-4o-mini')
  expect(result.choices[0]?.message.content).toBe('Hello from upstream')
  expect(result.choices[0]?.message.role).toBe('assistant')
  expect(result.choices[0]?.finish_reason).toBe('stop')
  expect(result.usage?.total_tokens).toBe(12)
})

test('preserves tool_calls in synthesized chunk', async () => {
  const body: ChatCompletionsJsonBody = {
    id: 'cc_3',
    object: 'chat.completion',
    created: 300,
    model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  }
  const result = await collectChatCompletionsProtocolEventsToResult(
    synthesizeChatCompletionsFramesFromJson(body),
  )
  expect(result.choices[0]?.message.tool_calls).toHaveLength(1)
  expect(result.choices[0]?.message.tool_calls?.[0]?.function.name).toBe('get_weather')
  expect(result.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe('{"city":"SF"}')
  expect(result.choices[0]?.finish_reason).toBe('tool_calls')
})
