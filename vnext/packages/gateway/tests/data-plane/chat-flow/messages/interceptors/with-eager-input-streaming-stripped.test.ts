import { test, expect } from 'bun:test'
import { withEagerInputStreamingStripped } from '../../../../../src/data-plane/chat-flow/messages/interceptors/with-eager-input-streaming-stripped'
import type { Invocation, RequestContext, TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>', upstream: '<unknown>', modelKey: '<unknown>', cost: null,
}
const baseCtx: RequestContext = { requestStartedAt: Date.now() }

const inv = (
  payload: Record<string, unknown>,
  flags: string[] = ['strip-eager-input-streaming'],
): Invocation => ({
  endpoint: 'messages',
  enabledFlags: new Set(flags),
  sourceApi: 'messages',
  payload,
  headers: {},
})

const okRun = () =>
  Promise.resolve(
    llmEventResult(
      (async function* () { yield doneFrame() })() as AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
      stubIdentity,
    ),
  )

test('flag on: strips eager_input_streaming from every tool', async () => {
  const i = inv({
    tools: [
      { name: 'a', type: 'custom', eager_input_streaming: true, input_schema: {} },
      { name: 'b', type: 'custom', input_schema: {} },
    ],
  })
  await withEagerInputStreamingStripped(i, baseCtx, okRun)
  const tools = i.payload.tools as Array<Record<string, unknown>>
  expect(tools[0]).not.toHaveProperty('eager_input_streaming')
  expect(tools[0].name).toBe('a')
  expect(tools[1]).not.toHaveProperty('eager_input_streaming')
})

test('flag off: leaves eager_input_streaming untouched', async () => {
  const i = inv(
    { tools: [{ name: 'a', type: 'custom', eager_input_streaming: true, input_schema: {} }] },
    [],
  )
  await withEagerInputStreamingStripped(i, baseCtx, okRun)
  const tools = i.payload.tools as Array<Record<string, unknown>>
  expect(tools[0].eager_input_streaming).toBe(true)
})

test('flag on, no tools: no-op (does not crash)', async () => {
  const i = inv({})
  await withEagerInputStreamingStripped(i, baseCtx, okRun)
  expect(i.payload.tools).toBeUndefined()
})

test('flag on, tools is not an array: no-op', async () => {
  const i = inv({ tools: 'not-an-array' as unknown as never })
  await withEagerInputStreamingStripped(i, baseCtx, okRun)
  expect(i.payload.tools).toBe('not-an-array')
})

test('flag on, non-object tool entries pass through untouched', async () => {
  const i = inv({ tools: ['weird-string', null, { name: 'ok', eager_input_streaming: true }] })
  await withEagerInputStreamingStripped(i, baseCtx, okRun)
  const tools = i.payload.tools as unknown[]
  expect(tools[0]).toBe('weird-string')
  expect(tools[1]).toBeNull()
  expect(tools[2]).not.toHaveProperty('eager_input_streaming')
})
