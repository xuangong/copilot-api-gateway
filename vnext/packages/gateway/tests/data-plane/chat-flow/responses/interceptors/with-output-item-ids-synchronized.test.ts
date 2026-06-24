import { test, expect } from 'bun:test'
import { withOutputItemIdsSynchronized } from '../../../../../src/data-plane/chat-flow/responses/interceptors/with-output-item-ids-synchronized'
import type { Invocation, RequestContext } from '@vnext-llm/protocols/common'
import {
  llmEventResult,
  type LlmExecuteResult,
  type TelemetryModelIdentity,
} from '@vnext-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vnext-gateway/result'
import type { ResponsesStreamEvent } from '@vnext-llm/protocols/responses'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}

const baseInv: Invocation = {
  endpoint: 'responses',
  enabledFlags: new Set(),
  sourceApi: 'responses',
  payload: { model: 'm', stream: true },
  headers: {},
}
const baseCtx: RequestContext = { requestStartedAt: Date.now() }

const eventFrame = (event: ResponsesStreamEvent): ProtocolFrame<ResponsesStreamEvent> => ({
  type: 'event',
  event,
})

const runEvents = (
  ...events: ResponsesStreamEvent[]
): (() => Promise<LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>) =>
  async () =>
    llmEventResult(
      (async function* () {
        for (const e of events) yield eventFrame(e)
        yield doneFrame()
      })(),
      stubIdentity,
    )

const collect = async (
  result: LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>,
): Promise<ResponsesStreamEvent[]> => {
  if (result.type !== 'events') throw new Error('expected events')
  const out: ResponsesStreamEvent[] = []
  for await (const frame of result.events) {
    if (frame.type === 'event') out.push(frame.event)
  }
  return out
}

test('withOutputItemIdsSynchronized: synthesizes id when output_item.added omits item.id', async () => {
  const result = await withOutputItemIdsSynchronized(
    baseInv,
    baseCtx,
    runEvents({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message' } as never,
    }),
  )
  const events = await collect(result)
  const added = events[0] as { item: { id: string } }
  expect(added.item.id).toMatch(/^oi_0_[0-9a-f]{16}$/)
})

test('withOutputItemIdsSynchronized: pins divergent item.id on output_item.done back to .added id', async () => {
  const result = await withOutputItemIdsSynchronized(
    baseInv,
    baseCtx,
    runEvents(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'pinned-1', type: 'message' } as never,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'different-2', type: 'message' } as never,
      },
    ),
  )
  const events = await collect(result)
  const done = events[1] as { item: { id: string } }
  expect(done.item.id).toBe('pinned-1')
})

test('withOutputItemIdsSynchronized: rewrites mid-item item_id on delta events', async () => {
  const result = await withOutputItemIdsSynchronized(
    baseInv,
    baseCtx,
    runEvents(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'pinned-1', type: 'message' } as never,
      },
      {
        type: 'response.output_text.delta',
        item_id: 'wrong-mid',
        output_index: 0,
        content_index: 0,
        delta: 'hi',
      },
    ),
  )
  const events = await collect(result)
  const delta = events[1] as { item_id: string }
  expect(delta.item_id).toBe('pinned-1')
})

test('withOutputItemIdsSynchronized: passes through events lacking output_index', async () => {
  const result = await withOutputItemIdsSynchronized(
    baseInv,
    baseCtx,
    runEvents({ type: 'response.created', response: { id: 'r1' } as never }),
  )
  const events = await collect(result)
  expect(events).toHaveLength(1)
  expect((events[0] as { type: string }).type).toBe('response.created')
})

test('withOutputItemIdsSynchronized: passes through non-events results', async () => {
  const result = await withOutputItemIdsSynchronized(baseInv, baseCtx, async () => ({
    type: 'upstream-error',
    status: 500,
    headers: new Headers(),
    body: new TextEncoder().encode('boom'),
  }))
  expect(result.type).toBe('upstream-error')
})
