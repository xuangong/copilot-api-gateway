import { test, expect } from 'bun:test'
import { withUsageStreamOptionsIncluded } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors/include-usage-stream-options'
import { chatCompletionsInterceptors } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors'
import { runInterceptors } from '@vibe-core/service'
import {
  llmEventResult,
  type LlmExecuteResult,
  type Invocation,
  type RequestContext,
  type TelemetryModelIdentity,
} from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ChatCompletionsStreamEvent } from '@vibe-llm/protocols/chat'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}

const doneOnlyEvents = (): AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>> =>
  (async function* () {
    yield doneFrame()
  })()

const fakeRun = async (): Promise<LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> =>
  llmEventResult(doneOnlyEvents(), stubIdentity)

const baseInv = (payload: Record<string, unknown>): Invocation => ({
  endpoint: 'chat_completions',
  enabledFlags: new Set(),
  sourceApi: 'chat_completions',
  payload,
  headers: {},
})

const baseCtx: RequestContext = { requestStartedAt: Date.now() }

test('withUsageStreamOptionsIncluded: adds stream_options.include_usage when absent', async () => {
  const inv = baseInv({ model: 'm', stream: true })
  await withUsageStreamOptionsIncluded(inv, baseCtx, fakeRun)
  expect(inv.payload.stream_options).toEqual({ include_usage: true })
})

test('withUsageStreamOptionsIncluded: flips include_usage:false to true and preserves sibling keys', async () => {
  const inv = baseInv({
    model: 'm',
    stream: true,
    stream_options: { include_usage: false, foo: 'bar' },
  })
  await withUsageStreamOptionsIncluded(inv, baseCtx, fakeRun)
  expect(inv.payload.stream_options).toEqual({ foo: 'bar', include_usage: true })
})

test('withUsageStreamOptionsIncluded: preserves include_usage:true', async () => {
  const inv = baseInv({
    model: 'm',
    stream: true,
    stream_options: { include_usage: true },
  })
  await withUsageStreamOptionsIncluded(inv, baseCtx, fakeRun)
  expect(inv.payload.stream_options).toEqual({ include_usage: true })
})

test('withUsageStreamOptionsIncluded: no-op when stream !== true', async () => {
  const inv = baseInv({ model: 'm' })
  await withUsageStreamOptionsIncluded(inv, baseCtx, fakeRun)
  expect(inv.payload.stream_options).toBeUndefined()

  const invStreamFalse = baseInv({ model: 'm', stream: false })
  await withUsageStreamOptionsIncluded(invStreamFalse, baseCtx, fakeRun)
  expect(invStreamFalse.payload.stream_options).toBeUndefined()
})

test('chatCompletionsInterceptors chain mutates payload before terminal', async () => {
  const inv = baseInv({ model: 'm', stream: true })
  let payloadSeenByTerminal: unknown = null
  const terminal = async (): Promise<LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    payloadSeenByTerminal = JSON.parse(JSON.stringify(inv.payload))
    return llmEventResult(doneOnlyEvents(), stubIdentity)
  }
  await runInterceptors(inv, baseCtx, chatCompletionsInterceptors, terminal)
  const seen = payloadSeenByTerminal as { stream_options?: unknown }
  expect(seen.stream_options).toEqual({ include_usage: true })
})
