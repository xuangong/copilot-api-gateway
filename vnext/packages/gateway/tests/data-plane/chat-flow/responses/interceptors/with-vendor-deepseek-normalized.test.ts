import { test, expect } from 'bun:test'
import { withVendorDeepSeekResponsesNormalize } from '../../../../../src/data-plane/chat-flow/responses/interceptors/with-vendor-deepseek-normalized'
import type { Invocation, RequestContext, TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ResponsesStreamEvent } from '@vibe-llm/protocols/responses'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}
const baseCtx: RequestContext = { requestStartedAt: Date.now() }

const inv = (
  payload: Record<string, unknown>,
  enabledFlags: ReadonlySet<string> = new Set(['vendor-deepseek']),
): Invocation => ({
  endpoint: 'responses',
  enabledFlags,
  sourceApi: 'responses',
  payload,
  headers: {},
})

const okRun = () =>
  Promise.resolve(
    llmEventResult(
      (async function* () {
        yield doneFrame()
      })() as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
      stubIdentity,
    ),
  )

test('deepseek responses: reasoning.effort="none" → thinking:{type:"disabled"}', async () => {
  const i = inv({
    model: 'deepseek-reasoner',
    input: [{ role: 'user', content: 'hi' }],
    reasoning: { effort: 'none' },
  })
  await withVendorDeepSeekResponsesNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning).toBeUndefined()
  expect(i.payload.thinking).toEqual({ type: 'disabled' })
})

test('deepseek responses: leaves reasoning.effort="high" untouched', async () => {
  const i = inv({
    model: 'deepseek-reasoner',
    input: [{ role: 'user', content: 'hi' }],
    reasoning: { effort: 'high' },
  })
  await withVendorDeepSeekResponsesNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning).toEqual({ effort: 'high' })
  expect(i.payload.thinking).toBeUndefined()
})

test('deepseek responses: no-op when reasoning absent', async () => {
  const i = inv({
    model: 'deepseek-reasoner',
    input: [{ role: 'user', content: 'hi' }],
  })
  await withVendorDeepSeekResponsesNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning).toBeUndefined()
  expect(i.payload.thinking).toBeUndefined()
})

test('deepseek responses: early-returns when flag is not set', async () => {
  const i = inv(
    {
      model: 'deepseek-reasoner',
      input: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'none' },
    },
    new Set(),
  )
  await withVendorDeepSeekResponsesNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning).toEqual({ effort: 'none' })
  expect(i.payload.thinking).toBeUndefined()
})
