import { test, expect } from 'bun:test'
import { withToolArgumentWhitespaceAborted } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors/with-tool-argument-whitespace-aborted'
import type { Invocation, RequestContext } from '@vibe-llm/protocols/common'
import {
  llmEventResult,
  type LlmExecuteResult,
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

const baseInv: Invocation = {
  endpoint: 'chat_completions',
  enabledFlags: new Set(),
  sourceApi: 'chat_completions',
  payload: { model: 'm', stream: true },
  headers: {},
}
const baseCtx: RequestContext = { requestStartedAt: Date.now() }

const eventFrame = (
  event: ChatCompletionsStreamEvent,
): ProtocolFrame<ChatCompletionsStreamEvent> => ({ type: 'event', event })

const toolDelta = (
  toolIndex: number,
  args: string,
): ChatCompletionsStreamEvent => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          { index: toolIndex, function: { arguments: args } },
        ],
      },
      finish_reason: null,
    },
  ],
})

const runEvents = (
  ...events: ChatCompletionsStreamEvent[]
): (() => Promise<LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>>) =>
  async () =>
    llmEventResult(
      (async function* () {
        for (const e of events) yield eventFrame(e)
        yield doneFrame()
      })(),
      stubIdentity,
    )

const collect = async (
  result: LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>,
): Promise<ProtocolFrame<ChatCompletionsStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events')
  const out: ProtocolFrame<ChatCompletionsStreamEvent>[] = []
  for await (const frame of result.events) out.push(frame)
  return out
}

test('chat withToolArgumentWhitespaceAborted: passes through normal arg deltas', async () => {
  const result = await withToolArgumentWhitespaceAborted(
    baseInv,
    baseCtx,
    runEvents(toolDelta(0, '{"foo":"bar"}')),
  )
  const frames = await collect(result)
  expect(frames).toHaveLength(2)
  expect(frames[0]?.type).toBe('event')
  expect(frames[1]?.type).toBe('done')
})

test('chat withToolArgumentWhitespaceAborted: throws when whitespace exceeds threshold', async () => {
  const result = await withToolArgumentWhitespaceAborted(
    baseInv,
    baseCtx,
    runEvents(toolDelta(0, '\n'.repeat(21)), toolDelta(0, '{"foo":"bar"}')),
  )
  expect(result.type).toBe('events')
  await expect(collect(result)).rejects.toThrow(/whitespace/i)
})

test('chat withToolArgumentWhitespaceAborted: tracks whitespace per tool index independently', async () => {
  const result = await withToolArgumentWhitespaceAborted(
    baseInv,
    baseCtx,
    runEvents(
      toolDelta(0, '\n'.repeat(11)),
      toolDelta(1, '\n'.repeat(11)),
      toolDelta(0, '{"a":1}'),
      toolDelta(1, '{"b":2}'),
    ),
  )
  const frames = await collect(result)
  expect(frames[frames.length - 1]?.type).toBe('done')
})

test('chat withToolArgumentWhitespaceAborted: ignores choices without tool_calls', async () => {
  const result = await withToolArgumentWhitespaceAborted(
    baseInv,
    baseCtx,
    runEvents({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'm',
      choices: [{ index: 0, delta: { content: '\n'.repeat(50) }, finish_reason: null }],
    }),
  )
  const frames = await collect(result)
  expect(frames).toHaveLength(2)
})

test('chat withToolArgumentWhitespaceAborted: passes through non-events results', async () => {
  const result = await withToolArgumentWhitespaceAborted(baseInv, baseCtx, async () => ({
    type: 'upstream-error',
    status: 502,
    headers: new Headers(),
    body: new TextEncoder().encode('bad'),
  }))
  expect(result.type).toBe('upstream-error')
})
