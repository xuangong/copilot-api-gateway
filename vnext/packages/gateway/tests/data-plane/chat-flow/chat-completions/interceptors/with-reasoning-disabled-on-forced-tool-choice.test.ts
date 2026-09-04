import { test, expect } from 'bun:test'
import { withReasoningDisabledOnForcedToolChoice } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors/with-reasoning-disabled-on-forced-tool-choice'
import type { Invocation, RequestContext, TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ChatCompletionsStreamEvent } from '@vibe-llm/protocols/chat'

const stubIdentity: TelemetryModelIdentity = {
  incomingModel: '<unknown>',
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
  endpoint: 'chat_completions',
  enabledFlags,
  sourceApi: 'chat_completions',
  payload,
  headers: {},
})

const okRun = () =>
  Promise.resolve(
    llmEventResult(
      (async function* () {
        yield doneFrame()
      })() as AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
      stubIdentity,
    ),
  )

test('cc: tool_choice="required" injects reasoning_effort=none', async () => {
  const i = inv({ tool_choice: 'required' })
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.reasoning_effort).toBe('none')
})

test('cc: tool_choice object injects reasoning_effort=none', async () => {
  const i = inv({ tool_choice: { type: 'function', function: { name: 'x' } } })
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.reasoning_effort).toBe('none')
})

test('cc: tool_choice="auto" leaves payload unchanged', async () => {
  const i = inv({ tool_choice: 'auto' })
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.reasoning_effort).toBeUndefined()
})

test('cc: no tool_choice leaves payload unchanged', async () => {
  const i = inv({})
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.reasoning_effort).toBeUndefined()
})

test('cc: flag off leaves payload unchanged', async () => {
  const i = inv({ tool_choice: 'required' }, new Set())
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.reasoning_effort).toBeUndefined()
})
