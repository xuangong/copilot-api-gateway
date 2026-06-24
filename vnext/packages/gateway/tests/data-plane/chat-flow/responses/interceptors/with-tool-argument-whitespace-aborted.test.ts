import { test, expect } from 'bun:test'
import { withToolArgumentWhitespaceAborted } from '../../../../../src/data-plane/chat-flow/responses/interceptors/with-tool-argument-whitespace-aborted'
import type { Invocation, RequestContext } from '@vnext-llm/protocols/common'
import {
  doneFrame,
  eventResult,
  type ExecuteResult,
  type ProtocolFrame,
  type TelemetryModelIdentity,
} from '@vnext-llm/protocols/common'
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

const argDelta = (output_index: number, delta: string): ResponsesStreamEvent =>
  ({
    type: 'response.function_call_arguments.delta',
    item_id: `i${output_index}`,
    output_index,
    delta,
  }) as ResponsesStreamEvent

const runEvents = (
  ...events: ResponsesStreamEvent[]
): (() => Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>) =>
  async () =>
    eventResult(
      (async function* () {
        for (const e of events) yield eventFrame(e)
        yield doneFrame()
      })(),
      stubIdentity,
    )

const collect = async (
  result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>,
): Promise<ProtocolFrame<ResponsesStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events')
  const out: ProtocolFrame<ResponsesStreamEvent>[] = []
  for await (const frame of result.events) out.push(frame)
  return out
}

test('withToolArgumentWhitespaceAborted: passes through normal arg deltas', async () => {
  const result = await withToolArgumentWhitespaceAborted(
    baseInv,
    baseCtx,
    runEvents(argDelta(0, '{"foo":"bar"}')),
  )
  const frames = await collect(result)
  expect(frames).toHaveLength(2)
  expect(frames[0]?.type).toBe('event')
  expect(frames[1]?.type).toBe('done')
})

test('withToolArgumentWhitespaceAborted: aborts when whitespace exceeds threshold', async () => {
  // 21 newlines triggers > MAX_CONSECUTIVE_WHITESPACE (20)
  const result = await withToolArgumentWhitespaceAborted(
    baseInv,
    baseCtx,
    runEvents(argDelta(0, '\n'.repeat(21)), argDelta(0, '{"foo":"bar"}')),
  )
  const frames = await collect(result)
  // Last two frames should be error event + done
  const last = frames[frames.length - 1]
  const second = frames[frames.length - 2]
  expect(last?.type).toBe('done')
  expect(second?.type).toBe('event')
  if (second?.type === 'event') {
    expect((second.event as { type: string }).type).toBe('error')
  }
})

test('withToolArgumentWhitespaceAborted: tracks whitespace per output_index independently', async () => {
  // Index 0 hits 11 newlines, index 1 hits 11 newlines — neither alone exceeds 20.
  const result = await withToolArgumentWhitespaceAborted(
    baseInv,
    baseCtx,
    runEvents(
      argDelta(0, '\n'.repeat(11)),
      argDelta(1, '\n'.repeat(11)),
      argDelta(0, '{"a":1}'),
      argDelta(1, '{"b":2}'),
    ),
  )
  const frames = await collect(result)
  // No error event — last frame is done
  const last = frames[frames.length - 1]
  expect(last?.type).toBe('done')
  for (const f of frames) {
    if (f.type === 'event') {
      expect((f.event as { type: string }).type).not.toBe('error')
    }
  }
})

test('withToolArgumentWhitespaceAborted: passes through non-arg-delta events untouched', async () => {
  const result = await withToolArgumentWhitespaceAborted(
    baseInv,
    baseCtx,
    runEvents({ type: 'response.created', response: { id: 'r1' } as never }),
  )
  const frames = await collect(result)
  expect(frames).toHaveLength(2)
})

test('withToolArgumentWhitespaceAborted: passes through non-events results', async () => {
  const result = await withToolArgumentWhitespaceAborted(baseInv, baseCtx, async () => ({
    type: 'upstream-error',
    status: 502,
    headers: new Headers(),
    body: new TextEncoder().encode('bad'),
  }))
  expect(result.type).toBe('upstream-error')
})
