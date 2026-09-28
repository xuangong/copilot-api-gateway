import { expect, test } from 'bun:test'
import { synthesizeChatCompletionsFramesFromJson } from '../../../../../src/data-plane/chat-flow/chat-completions/events/json-to-frames.ts'
import { reassembleChatCompletions } from '../../../../../src/data-plane/chat-flow/chat-completions/events/reassemble.ts'

test('Chat JSON expansion and SSE reassembly retain the refusal field', async () => {
  const frames = synthesizeChatCompletionsFramesFromJson({
    id: 'c', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Before', refusal: 'Denied' }, finish_reason: 'stop' }],
  })
  async function* events() {
    for await (const frame of frames) if (frame.type === 'event') yield frame.event
  }
  const result = await reassembleChatCompletions(events())
  expect(result.choices[0]?.message).toMatchObject({ content: 'Before', refusal: 'Denied' })
})

test('Chat refusal fragments reassemble in order, including an explicit empty fragment', async () => {
  async function* chunks() {
    for (const refusal of ['', 'De', 'nied']) yield {
      id: 'c', object: 'chat.completion.chunk' as const, created: 1, model: 'm',
      choices: [{ index: 0, delta: { refusal }, finish_reason: null }],
    }
    yield { id: 'c', object: 'chat.completion.chunk' as const, created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  }
  const result = await reassembleChatCompletions(chunks() as never)
  expect(result.choices[0]?.message.refusal).toBe('Denied')
})
