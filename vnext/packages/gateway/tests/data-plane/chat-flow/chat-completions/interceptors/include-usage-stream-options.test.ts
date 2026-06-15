import { test, expect } from 'bun:test'
import { withUsageStreamOptionsIncluded } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors/include-usage-stream-options'
import { chatCompletionsInterceptors } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors'
import {
  runInterceptors,
  type Invocation,
  type RequestContext,
} from '@vnext/interceptor'
import {
  doneFrame,
  eventResult,
  type ExecuteResult,
  type ProtocolFrame,
} from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'

const doneOnlyEvents = (): AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>> =>
  (async function* () {
    yield doneFrame()
  })()

const fakeRun = async (): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> =>
  eventResult(doneOnlyEvents())

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
  const terminal = async (): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    payloadSeenByTerminal = JSON.parse(JSON.stringify(inv.payload))
    return eventResult(doneOnlyEvents())
  }
  await runInterceptors(inv, baseCtx, chatCompletionsInterceptors, terminal)
  const seen = payloadSeenByTerminal as { stream_options?: unknown }
  expect(seen.stream_options).toEqual({ include_usage: true })
})
