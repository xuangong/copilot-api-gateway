import { test, expect } from 'bun:test'
import {
  withThinkingDisplayPromoted,
  resolveMessagesDownstreamThinkingDisplay,
} from '../../../../../src/data-plane/chat-flow/messages/interceptors/with-thinking-display-promoted'
import type { Invocation, RequestContext } from '@vnext-llm/protocols/common'
import {
  llmEventResult,
  type LlmExecuteResult,
  type TelemetryModelIdentity,
} from '@vnext-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vnext-gateway/result'
import type { MessagesStreamEvent } from '@vnext-llm/protocols/messages'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}

const baseCtx: RequestContext = { requestStartedAt: Date.now() }

const makeInv = (payload: Record<string, unknown>): Invocation => ({
  endpoint: 'messages',
  enabledFlags: new Set(),
  sourceApi: 'messages',
  payload,
  headers: {},
})

const eventFrame = (event: MessagesStreamEvent): ProtocolFrame<MessagesStreamEvent> => ({
  type: 'event',
  event,
})

const runEvents = (
  ...events: MessagesStreamEvent[]
): (() => Promise<LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>>) =>
  async () =>
    llmEventResult(
      (async function* () {
        for (const e of events) yield eventFrame(e)
        yield doneFrame()
      })(),
      stubIdentity,
    )

const collect = async (
  result: LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>,
): Promise<ProtocolFrame<MessagesStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events')
  const out: ProtocolFrame<MessagesStreamEvent>[] = []
  for await (const frame of result.events) out.push(frame)
  return out
}

test('resolveMessagesDownstreamThinkingDisplay: explicit valid display passes through', () => {
  expect(resolveMessagesDownstreamThinkingDisplay({ thinking: { display: 'full' } })).toBe('full')
  expect(resolveMessagesDownstreamThinkingDisplay({ thinking: { display: 'omitted' } })).toBe(
    'omitted',
  )
  expect(resolveMessagesDownstreamThinkingDisplay({ thinking: { display: 'summarized' } })).toBe(
    'summarized',
  )
})

test('resolveMessagesDownstreamThinkingDisplay: defaults to omitted for Claude ≥4.7', () => {
  expect(resolveMessagesDownstreamThinkingDisplay({ model: 'claude-sonnet-4-7' })).toBe('omitted')
  expect(resolveMessagesDownstreamThinkingDisplay({ model: 'claude-opus-4-7-20251015' })).toBe(
    'omitted',
  )
  expect(resolveMessagesDownstreamThinkingDisplay({ model: 'claude-sonnet-4-7-high' })).toBe(
    'omitted',
  )
})

test('resolveMessagesDownstreamThinkingDisplay: defaults to summarized for older Claude', () => {
  expect(resolveMessagesDownstreamThinkingDisplay({ model: 'claude-sonnet-4-5' })).toBe(
    'summarized',
  )
  expect(resolveMessagesDownstreamThinkingDisplay({ model: 'claude-3.5-sonnet' })).toBe(
    'summarized',
  )
})

test('withThinkingDisplayPromoted: upgrades inv.payload.thinking.display to summarized for 4.7 default-omitted', async () => {
  const inv = makeInv({
    model: 'claude-sonnet-4-7',
    thinking: { type: 'enabled', budget_tokens: 1024 },
  })
  await withThinkingDisplayPromoted(inv, baseCtx, runEvents())
  const thinking = inv.payload.thinking as { display?: string }
  expect(thinking.display).toBe('summarized')
})

test('withThinkingDisplayPromoted: leaves payload untouched when display is already full', async () => {
  const inv = makeInv({
    model: 'claude-sonnet-4-7',
    thinking: { type: 'enabled', display: 'full' },
  })
  await withThinkingDisplayPromoted(inv, baseCtx, runEvents())
  const thinking = inv.payload.thinking as { display?: string }
  expect(thinking.display).toBe('full')
})

test('withThinkingDisplayPromoted: no-op when thinking is disabled', async () => {
  const inv = makeInv({
    model: 'claude-sonnet-4-7',
    thinking: { type: 'disabled' },
  })
  const result = await withThinkingDisplayPromoted(
    inv,
    baseCtx,
    runEvents({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'hidden reasoning' },
    } as MessagesStreamEvent),
  )
  const thinking = inv.payload.thinking as { display?: string; type: string }
  expect(thinking.type).toBe('disabled')
  expect(thinking.display).toBeUndefined()
  // Stream should pass through untouched (thinking_delta NOT stripped).
  const frames = await collect(result)
  const deltaFrames = frames.filter(
    (f) => f.type === 'event' && (f.event as { type: string }).type === 'content_block_delta',
  )
  expect(deltaFrames).toHaveLength(1)
})

test('withThinkingDisplayPromoted: strips thinking text and drops thinking_delta when downstream is omitted', async () => {
  const inv = makeInv({
    model: 'claude-sonnet-4-7',
    thinking: { type: 'enabled', budget_tokens: 1024 },
  })
  const result = await withThinkingDisplayPromoted(
    inv,
    baseCtx,
    runEvents(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'visible reasoning' },
      } as MessagesStreamEvent,
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'more reasoning' },
      } as MessagesStreamEvent,
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-bytes' },
      } as MessagesStreamEvent,
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'hello' },
      } as MessagesStreamEvent,
    ),
  )
  const frames = await collect(result)
  const events = frames.filter((f) => f.type === 'event')

  // thinking_delta dropped → 1 start + 1 signature_delta + 1 text_delta = 3 events
  expect(events).toHaveLength(3)

  const startFrame = events[0]
  if (startFrame?.type === 'event') {
    const block = (startFrame.event as { content_block: { type: string; thinking: string } })
      .content_block
    expect(block.type).toBe('thinking')
    expect(block.thinking).toBe('') // text stripped
  }

  // signature_delta preserved verbatim
  const sigFrame = events[1]
  if (sigFrame?.type === 'event') {
    const delta = (sigFrame.event as { delta: { type: string; signature: string } }).delta
    expect(delta.type).toBe('signature_delta')
    expect(delta.signature).toBe('sig-bytes')
  }

  // unrelated text_delta passes through
  const textFrame = events[2]
  if (textFrame?.type === 'event') {
    const delta = (textFrame.event as { delta: { type: string; text: string } }).delta
    expect(delta.type).toBe('text_delta')
    expect(delta.text).toBe('hello')
  }
})

test('withThinkingDisplayPromoted: passes stream untouched when downstream is full', async () => {
  const inv = makeInv({
    model: 'claude-sonnet-4-7',
    thinking: { type: 'enabled', display: 'full' },
  })
  const result = await withThinkingDisplayPromoted(
    inv,
    baseCtx,
    runEvents({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'visible reasoning' },
    } as MessagesStreamEvent),
  )
  const frames = await collect(result)
  const events = frames.filter((f) => f.type === 'event')
  expect(events).toHaveLength(1)
  if (events[0]?.type === 'event') {
    const delta = (events[0].event as { delta: { type: string; thinking: string } }).delta
    expect(delta.thinking).toBe('visible reasoning')
  }
})

test('withThinkingDisplayPromoted: passes stream untouched when downstream wanted summarized (older Claude)', async () => {
  const inv = makeInv({
    model: 'claude-sonnet-4-5',
    thinking: { type: 'enabled' },
  })
  const result = await withThinkingDisplayPromoted(
    inv,
    baseCtx,
    runEvents({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'summary text' },
    } as MessagesStreamEvent),
  )
  const frames = await collect(result)
  const events = frames.filter((f) => f.type === 'event')
  expect(events).toHaveLength(1)
  if (events[0]?.type === 'event') {
    const delta = (events[0].event as { delta: { type: string; thinking: string } }).delta
    expect(delta.thinking).toBe('summary text') // not stripped
  }
})

test('withThinkingDisplayPromoted: passes through non-events results', async () => {
  const inv = makeInv({
    model: 'claude-sonnet-4-7',
    thinking: { type: 'enabled' },
  })
  const result = await withThinkingDisplayPromoted(inv, baseCtx, async () => ({
    type: 'upstream-error',
    status: 502,
    headers: new Headers(),
    body: new TextEncoder().encode('bad'),
  }))
  expect(result.type).toBe('upstream-error')
})
