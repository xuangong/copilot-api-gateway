import { test, expect } from 'bun:test'
import { withReasoningDisabledOnForcedToolChoice } from '../../../../../src/data-plane/chat-flow/messages/interceptors/with-reasoning-disabled-on-forced-tool-choice'
import type { Invocation, RequestContext, TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'

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
  endpoint: 'messages',
  enabledFlags,
  sourceApi: 'messages',
  payload,
  headers: {},
})

const okRun = () =>
  Promise.resolve(
    llmEventResult(
      (async function* () {
        yield doneFrame()
      })() as AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
      stubIdentity,
    ),
  )

test('messages: tool_choice type=tool → thinking disabled', async () => {
  const i = inv({ tool_choice: { type: 'tool', name: 'x' } })
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.thinking).toEqual({ type: 'disabled' })
})

test('messages: tool_choice type=any → thinking disabled', async () => {
  const i = inv({ tool_choice: { type: 'any' } })
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.thinking).toEqual({ type: 'disabled' })
})

test('messages: strips output_config.effort but preserves other output_config fields', async () => {
  const i = inv({
    tool_choice: { type: 'tool' },
    output_config: { effort: 'high', format: { type: 'json' } },
  })
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.output_config).toEqual({ format: { type: 'json' } })
  expect(i.payload.thinking).toEqual({ type: 'disabled' })
})

test('messages: drops output_config entirely if only had effort', async () => {
  const i = inv({
    tool_choice: { type: 'tool' },
    output_config: { effort: 'high' },
  })
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.output_config).toBeUndefined()
})

test('messages: tool_choice type=auto leaves payload unchanged', async () => {
  const i = inv({ tool_choice: { type: 'auto' } })
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.thinking).toBeUndefined()
})

test('messages: flag off leaves payload unchanged', async () => {
  const i = inv({ tool_choice: { type: 'tool' } }, new Set())
  await withReasoningDisabledOnForcedToolChoice(i, baseCtx, okRun)
  expect(i.payload.thinking).toBeUndefined()
})
