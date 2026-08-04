import { test, expect } from 'bun:test'
import { withVendorQwenResponsesNormalize } from '../../../../../src/data-plane/chat-flow/responses/interceptors/with-vendor-qwen-normalized'
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
  enabledFlags: ReadonlySet<string> = new Set(['vendor-qwen']),
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

test('qwen responses: reasoning.effort="none" → enable_thinking:false', async () => {
  const i = inv({
    model: 'qwen-max',
    input: [{ role: 'user', content: 'hi' }],
    reasoning: { effort: 'none' },
  })
  await withVendorQwenResponsesNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning).toBeUndefined()
  expect(i.payload.enable_thinking).toBe(false)
})

test('qwen responses: leaves reasoning.effort="high" untouched', async () => {
  const i = inv({
    model: 'qwen-max',
    input: [{ role: 'user', content: 'hi' }],
    reasoning: { effort: 'high' },
  })
  await withVendorQwenResponsesNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning).toEqual({ effort: 'high' })
  expect(i.payload.enable_thinking).toBeUndefined()
})

test('qwen responses: early-returns when flag is not set', async () => {
  const i = inv(
    {
      model: 'qwen-max',
      input: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'none' },
    },
    new Set(),
  )
  await withVendorQwenResponsesNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning).toEqual({ effort: 'none' })
  expect(i.payload.enable_thinking).toBeUndefined()
})
