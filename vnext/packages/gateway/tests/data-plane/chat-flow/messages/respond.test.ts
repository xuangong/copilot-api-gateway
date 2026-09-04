import { expect, test } from 'bun:test'
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'
import { llmEventResult, type TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'
import { respondMessages } from '../../../../src/data-plane/chat-flow/messages/respond.ts'
import { setupTestPlatform } from '../../../_setup-platform.ts'

const identity: TelemetryModelIdentity = {
  incomingModel: 'gpt-5.6-sol-fast',
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

test('Messages native error event is forwarded and records a failed request', async () => {
  const { repo } = setupTestPlatform()
  const failures: unknown[] = []
  const successes: unknown[] = []
  const errorIdentity: TelemetryModelIdentity = {
    incomingModel: 'public-message-model',
    model: 'public-message-model', upstream: 'upstream', modelKey: 'provider-message-model', cost: null,
  }
  async function* errorFrames(): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
    yield eventFrame({
      type: 'error', error: { type: 'api_error', message: 'upstream unavailable' },
    } as MessagesStreamEvent)
  }
  const response = await respondMessages(
    llmEventResult(errorFrames(), errorIdentity, {
      keyId: 'messages-native-error-key', model: errorIdentity.model, modelKey: errorIdentity.modelKey,
      upstream: 'upstream', stream: true, runtimeLocation: 'bun',
    }),
    {
      wantsStream: true,
      telemetryCtx: {
        apiKeyId: 'messages-native-error-key' as never, userAgent: null, requestId: 'messages-native-error-request',
        isStreaming: true, runtimeLocation: 'bun', requestStartedAt: Date.now(), sourceApi: 'messages',
      },
      dump: {
        frame: () => {}, failed: (error) => { failures.push(error) }, success: (value) => { successes.push(value) },
      } as never,
    },
  )
  const body = await response.text()
  expect(body).toContain('upstream unavailable')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await repo.usage.query({
    keyId: 'messages-native-error-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })).toEqual([])
  const performance = await repo.performance.query({
    keyId: 'messages-native-error-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(performance.summary).toHaveLength(1)
  expect(performance.summary[0]).toMatchObject({
    model: 'public-message-model', sourceApi: 'messages', targetApi: 'messages', errors: 1,
  })
  expect(failures).toEqual(['messages stream failed'])
  expect(successes).toEqual([])
})

test('Messages translated stream receives and outputs the mapped destination', async () => {
  let contextModel = ''
  const result = llmEventResult(
    frames() as AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
    identity,
    undefined,
    undefined,
    undefined,
    async function* (_events, context) {
      contextModel = context.model ?? ''
      yield { type: 'message_start', message: {
        id: 'translated', type: 'message', role: 'assistant', model: 'gpt-5.6-sol', content: [], stop_reason: null,
        stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
      } }
      yield { type: 'message_stop' }
    },
  )
  const response = await respondMessages(result, { wantsStream: true })
  expect(await response.text()).toContain('"model":"gpt-5.6-sol-fast"')
  expect(contextModel).toBe('gpt-5.6-sol-fast')
})

test('Messages stream keeps public model for a modelVersion provider revision', async () => {
  async function* modelVersionFrame(): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
    yield eventFrame({ type: 'message_stop', modelVersion: 'gpt-4-turbo-2025' } as unknown as MessagesStreamEvent)
  }
  const response = await respondMessages(llmEventResult(modelVersionFrame(), { ...identity, model: 'gpt-4-turbo', modelKey: 'gpt-4-turbo' }), { wantsStream: true })
  expect(await response.text()).toContain('"modelVersion":"gpt-4-turbo"')
})
