import { test, expect } from 'bun:test'
import { collectChatCompletionsProtocolEventsToResult, CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE } from '../../../../../src/data-plane/chat-flow/chat-completions/events/to-result'
import { eventFrame, doneFrame, type ProtocolFrame } from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'

const drainable = async function* (frames: ProtocolFrame<ChatCompletionsStreamEvent>[]) { for (const f of frames) yield f }

test('reassembles a completed stream', async () => {
  const result = await collectChatCompletionsProtocolEventsToResult(drainable([
    eventFrame({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] } as any),
    doneFrame(),
  ]))
  expect(result.choices[0]!.message.content).toBe('hi')
})

test('throws when stream ends without done', async () => {
  await expect(collectChatCompletionsProtocolEventsToResult(drainable([
    eventFrame({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'hi' } }] } as any),
  ]))).rejects.toThrow(CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE)
})
