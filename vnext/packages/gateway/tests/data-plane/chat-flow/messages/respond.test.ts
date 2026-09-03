import { expect, test } from 'bun:test'
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'
import { llmEventResult, type TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'
import { respondMessages } from '../../../../src/data-plane/chat-flow/messages/respond.ts'

const identity: TelemetryModelIdentity = {
  model: 'gpt-5.6-sol-fast', upstream: 'test', modelKey: 'gpt-5.6-sol-fast', cost: null,
}

const frames = async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  yield eventFrame({ type: 'message_start', message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'gpt-5.6-sol', content: [], stop_reason: null,
    stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
  } } as unknown as MessagesStreamEvent)
  yield eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } as unknown as MessagesStreamEvent)
  yield eventFrame({ type: 'message_stop' } as MessagesStreamEvent)
}

test('Messages stream and JSON retain mapped destination when upstream echoes base', async () => {
  const stream = await respondMessages(llmEventResult(frames(), identity), { wantsStream: true })
  expect(await stream.text()).toContain('"model":"gpt-5.6-sol-fast"')
  const json = await respondMessages(llmEventResult(frames(), identity), { wantsStream: false })
  expect((await json.json() as { model: string }).model).toBe('gpt-5.6-sol-fast')
})

test('Messages stream normalizes a modelVersion-only correction', async () => {
  async function* modelVersionFrame(): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
    yield eventFrame({ type: 'message_stop', modelVersion: 'gpt-4-turbo-2025' } as unknown as MessagesStreamEvent)
  }
  const response = await respondMessages(llmEventResult(modelVersionFrame(), { ...identity, model: 'gpt-4-turbo', modelKey: 'gpt-4-turbo' }), { wantsStream: true })
  expect(await response.text()).toContain('"modelVersion":"gpt-4-turbo-2025"')
})
