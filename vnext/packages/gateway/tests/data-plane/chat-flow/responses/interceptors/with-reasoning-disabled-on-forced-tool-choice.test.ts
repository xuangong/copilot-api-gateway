import { test, expect } from 'bun:test'
import { withReasoningDisabledOnForcedToolChoice } from '../../../../../src/data-plane/chat-flow/responses/interceptors/with-reasoning-disabled-on-forced-tool-choice'
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
  enabledFlags: ReadonlySet<string> = new Set(['disable-reasoning-on-forced-tool-choice']),
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

test('responses: tool_choice="required" injects reasoning.effort=none', async () => {
  const i = inv({ tool_choice: 'required', reasoning: { effort: 'high', summary: 'detailed' } })
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.reasoning).toEqual({ effort: 'none' })
})

test('responses: object tool_choice injects reasoning.effort=none', async () => {
  const i = inv({ tool_choice: { type: 'function', name: 'x' } })
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.reasoning).toEqual({ effort: 'none' })
})

test('responses: tool_choice="auto" leaves payload unchanged', async () => {
  const i = inv({ tool_choice: 'auto', reasoning: { effort: 'high' } })
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.reasoning).toEqual({ effort: 'high' })
})

test('responses: flag off leaves payload unchanged', async () => {
  const i = inv({ tool_choice: 'required', reasoning: { effort: 'high' } }, new Set())
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.reasoning).toEqual({ effort: 'high' })
})
