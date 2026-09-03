import { expect, test } from 'bun:test'
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'
import { llmEventResult, type TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import type { ResponsesResult, ResponsesStreamEvent } from '@vibe-llm/protocols/responses'
import { respondResponses } from '../../../../src/data-plane/chat-flow/responses/respond.ts'

const identity: TelemetryModelIdentity = {
  model: 'gpt-5.6-sol-fast', upstream: 'test', modelKey: 'gpt-5.6-sol-fast', cost: null,
}

const frames = async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const response: ResponsesResult = { id: 'resp_1', object: 'response', model: 'gpt-5.6-sol', output: [], status: 'completed', error: null, incomplete_details: null }
  yield eventFrame({ type: 'response.created', response } as ResponsesStreamEvent)
  yield eventFrame({ type: 'response.completed', response } as ResponsesStreamEvent)
}

test('Responses stream and JSON retain mapped destination when upstream echoes base', async () => {
  const stream = await respondResponses(llmEventResult(frames(), identity), { wantsStream: true })
  expect(await stream.text()).toContain('"model":"gpt-5.6-sol-fast"')
  const json = await respondResponses(llmEventResult(frames(), identity), { wantsStream: false })
  expect((await json.json() as { model: string }).model).toBe('gpt-5.6-sol-fast')
})

test('Responses stream normalizes a modelVersion-only correction', async () => {
  async function* source(): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.completed', modelVersion: 'gpt-4-turbo-2025', response: { id: 'x', object: 'response', model: 'gpt-4-turbo-2025', output: [], status: 'completed', error: null, incomplete_details: null } } as never)
  }
  const response = await respondResponses(llmEventResult(source(), { ...identity, model: 'gpt-4-turbo', modelKey: 'gpt-4-turbo' }), { wantsStream: true })
  expect(await response.text()).toContain('"modelVersion":"gpt-4-turbo-2025"')
})

test('Responses translated stream receives and outputs the mapped destination', async () => {
  let contextModel = ''
  const result = llmEventResult(
    frames() as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
    identity,
    undefined,
    undefined,
    undefined,
    async function* (_events, context) {
      contextModel = context.model ?? ''
      const response: ResponsesResult = { id: 'translated', object: 'response', model: 'gpt-5.6-sol', output: [], status: 'completed', error: null, incomplete_details: null }
      yield { type: 'response.completed', response }
    },
  )
  const response = await respondResponses(result, { wantsStream: true })
  expect(await response.text()).toContain('"model":"gpt-5.6-sol-fast"')
  expect(contextModel).toBe('gpt-5.6-sol-fast')
})

test('Responses translateBody receives the observed effective model', async () => {
  let model = ''
  const result = llmEventResult(frames(), identity, undefined, undefined, async (body, ctx) => {
    model = ctx.model ?? ''
    return body
  })
  await (await respondResponses(result, { wantsStream: false })).json()
  expect(model).toBe('gpt-5.6-sol-fast')
})
