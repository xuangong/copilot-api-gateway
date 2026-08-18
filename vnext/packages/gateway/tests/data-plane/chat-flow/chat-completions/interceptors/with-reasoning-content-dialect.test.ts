import { test, expect } from 'bun:test'
import { withReasoningContentDialect } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors/with-reasoning-content-dialect'
import type {
  Invocation,
  RequestContext,
  LlmExecuteResult,
  TelemetryModelIdentity,
} from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import { doneFrame, eventFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ChatCompletionsStreamEvent } from '@vibe-llm/protocols/chat'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}
const baseCtx: RequestContext = { requestStartedAt: Date.now() }

const inv = (
  payload: Record<string, unknown>,
  enabledFlags: ReadonlySet<string> = new Set(['reasoning-content-dialect']),
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

const runWith = (chunk: ChatCompletionsStreamEvent) => () =>
  Promise.resolve(
    llmEventResult(
      (async function* () {
        yield eventFrame(chunk)
      })() as AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
      stubIdentity,
    ),
  )

const collect = async (
  result: LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>,
): Promise<ProtocolFrame<ChatCompletionsStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events')
  const out: ProtocolFrame<ChatCompletionsStreamEvent>[] = []
  for await (const frame of result.events) out.push(frame)
  return out
}

const deltaChunk = (delta: Record<string, unknown>): ChatCompletionsStreamEvent => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'kimi-k2-thinking',
  choices: [
    {
      index: 0,
      delta: delta as ChatCompletionsStreamEvent['choices'][number]['delta'],
      finish_reason: null,
    },
  ],
})

// ── Outbound ─────────────────────────────────────────────────────

test('renames outbound reasoning_text → reasoning_content on assistant messages', async () => {
  const i = inv({
    model: 'deepseek-reasoner',
    messages: [
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: null,
        reasoning_text: 'let me check the docs',
        reasoning_opaque: 'opaque-blob',
        reasoning_items: [{ type: 'reasoning', summary: [] }],
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      },
    ],
  })
  await withReasoningContentDialect(i, baseCtx, okRun)
  const assistant = (i.payload.messages as Record<string, unknown>[])[1]!
  expect(assistant.reasoning_content).toBe('let me check the docs')
  expect(assistant.reasoning_text).toBeUndefined()
  expect(assistant.reasoning_opaque).toBeUndefined()
  expect(assistant.reasoning_items).toBeUndefined()
  expect((assistant.tool_calls as unknown[]).length).toBe(1)
})

test('synthesizes reasoning_content from reasoning_items.summary', async () => {
  const i = inv({
    model: 'deepseek-reasoner',
    messages: [
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: null,
        reasoning_items: [
          {
            type: 'reasoning',
            id: 'rs_1',
            summary: [
              { type: 'summary_text', text: 'step one. ' },
              { type: 'summary_text', text: 'step two.' },
            ],
          },
        ],
      },
    ],
  })
  await withReasoningContentDialect(i, baseCtx, okRun)
  const assistant = (i.payload.messages as Record<string, unknown>[])[1]!
  expect(assistant.reasoning_content).toBe('step one. step two.')
  expect(assistant.reasoning_items).toBeUndefined()
})

test('strips reasoning_items even when no summaries produce text', async () => {
  const i = inv({
    model: 'deepseek-reasoner',
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'answer', reasoning_items: [{ type: 'reasoning' }], reasoning_opaque: 'x' },
    ],
  })
  await withReasoningContentDialect(i, baseCtx, okRun)
  const assistant = (i.payload.messages as Record<string, unknown>[])[1]!
  expect(assistant.reasoning_content).toBeUndefined()
  expect(assistant.reasoning_items).toBeUndefined()
  expect(assistant.reasoning_opaque).toBeUndefined()
  expect(assistant.content).toBe('answer')
})

// ── Inbound ─────────────────────────────────────────────────────

test('renames inbound delta reasoning_content → reasoning_text', async () => {
  const i = inv({ model: 'deepseek-reasoner', messages: [] })
  const result = await withReasoningContentDialect(
    i,
    baseCtx,
    runWith(deltaChunk({ reasoning_content: 'thinking...' })),
  )
  const frames = await collect(result)
  expect(frames.length).toBe(1)
  const f = frames[0]!
  if (f.type !== 'event') throw new Error('expected event')
  const delta = f.event.choices[0]!.delta as Record<string, unknown>
  expect(delta.reasoning_text).toBe('thinking...')
  expect(delta.reasoning_content).toBeUndefined()
})

// ── Round trip ──────────────────────────────────────────────────

// Kimi's "preserved thinking" only works if the reasoning the client saw
// comes back verbatim on the next turn. Inbound rename and outbound
// rename have to be exact inverses for that to hold.
test('preserved thinking survives a full round trip', async () => {
  const upstreamThought = '先查文档，再决定调用哪个工具'

  const first = inv({ model: 'kimi-k2-thinking', messages: [{ role: 'user', content: 'hi' }] })
  const streamed = await collect(
    await withReasoningContentDialect(
      first,
      baseCtx,
      runWith(deltaChunk({ reasoning_content: upstreamThought })),
    ),
  )
  const f = streamed[0]!
  if (f.type !== 'event') throw new Error('expected event')
  const clientDelta = f.event.choices[0]!.delta as Record<string, unknown>
  expect(clientDelta.reasoning_text).toBe(upstreamThought)

  // The client echoes back exactly what it received.
  const second = inv({
    model: 'kimi-k2-thinking',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, reasoning_text: clientDelta.reasoning_text },
      { role: 'user', content: 'go on' },
    ],
  })
  await withReasoningContentDialect(second, baseCtx, okRun)
  const assistant = (second.payload.messages as Record<string, unknown>[])[1]!
  expect(assistant.reasoning_content).toBe(upstreamThought)
  expect(assistant.reasoning_text).toBeUndefined()
})

// ── Gating ──────────────────────────────────────────────────────

test('vendor-deepseek alone still enables the dialect', async () => {
  const i = inv(
    {
      model: 'deepseek-reasoner',
      messages: [{ role: 'assistant', content: null, reasoning_text: 'kept' }],
    },
    new Set(['vendor-deepseek']),
  )
  await withReasoningContentDialect(i, baseCtx, okRun)
  const assistant = (i.payload.messages as Record<string, unknown>[])[0]!
  expect(assistant.reasoning_content).toBe('kept')
})

test('early-returns when no flag is set', async () => {
  const i = inv(
    {
      model: 'deepseek-reasoner',
      messages: [{ role: 'assistant', content: null, reasoning_text: 'untouched' }],
    },
    new Set(),
  )
  await withReasoningContentDialect(i, baseCtx, okRun)
  const assistant = (i.payload.messages as Record<string, unknown>[])[0]!
  expect(assistant.reasoning_text).toBe('untouched')
  expect(assistant.reasoning_content).toBeUndefined()
})

test('leaves done frames untouched', async () => {
  const i = inv({ model: 'deepseek-reasoner', messages: [] })
  const done = doneFrame() as ProtocolFrame<ChatCompletionsStreamEvent>
  const result = await withReasoningContentDialect(i, baseCtx, () =>
    Promise.resolve(
      llmEventResult(
        (async function* () {
          yield done
        })() as AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
        stubIdentity,
      ),
    ),
  )
  expect(await collect(result)).toEqual([done])
})
