import { test, expect } from 'bun:test'
import { withVendorQwenChatCompletionsNormalize } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors/with-vendor-qwen-normalized'
import type {
  Invocation,
  RequestContext,
  TelemetryModelIdentity,
} from '@vibe-llm/protocols/common'
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
  enabledFlags: ReadonlySet<string> = new Set(['vendor-qwen']),
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

test('qwen: reasoning_effort:"none" → enable_thinking:false', async () => {
  const i = inv({
    model: 'qwen-max',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'none',
  })
  await withVendorQwenChatCompletionsNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning_effort).toBeUndefined()
  expect(i.payload.enable_thinking).toBe(false)
})

test('qwen: leaves reasoning_effort:"high" untouched', async () => {
  const i = inv({
    model: 'qwen-max',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
  })
  await withVendorQwenChatCompletionsNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning_effort).toBe('high')
  expect(i.payload.enable_thinking).toBeUndefined()
})

test('qwen: early-returns when flag is not set', async () => {
  const i = inv(
    {
      model: 'qwen-max',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none',
    },
    new Set(),
  )
  await withVendorQwenChatCompletionsNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning_effort).toBe('none')
  expect(i.payload.enable_thinking).toBeUndefined()
})
