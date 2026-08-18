import { test, expect } from 'bun:test'
import { withVendorDeepSeekChatCompletionsNormalize } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors/with-vendor-deepseek-normalized'
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
  enabledFlags: ReadonlySet<string> = new Set(['vendor-deepseek']),
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

const collect = async (
  result: LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>,
): Promise<ProtocolFrame<ChatCompletionsStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events')
  const out: ProtocolFrame<ChatCompletionsStreamEvent>[] = []
  for await (const frame of result.events) out.push(frame)
  return out
}

// ── Outbound ─────────────────────────────────────────────────────

test('deepseek: reasoning_effort:"none" → thinking:{type:"disabled"}', async () => {
  const i = inv({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'none',
  })
  await withVendorDeepSeekChatCompletionsNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning_effort).toBeUndefined()
  expect(i.payload.thinking).toEqual({ type: 'disabled' })
})

test('deepseek: leaves reasoning_effort:"high" untouched', async () => {
  const i = inv({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
  })
  await withVendorDeepSeekChatCompletionsNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning_effort).toBe('high')
  expect(i.payload.thinking).toBeUndefined()
})

test('deepseek: downgrades response_format json_schema → json_object', async () => {
  const i = inv({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'x', strict: true, schema: { type: 'object' } },
    },
  })
  await withVendorDeepSeekChatCompletionsNormalize(i, baseCtx, okRun)
  expect(i.payload.response_format).toEqual({ type: 'json_object' })
})

test('deepseek: leaves already-json_object response_format alone', async () => {
  const i = inv({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_object' },
  })
  await withVendorDeepSeekChatCompletionsNormalize(i, baseCtx, okRun)
  expect(i.payload.response_format).toEqual({ type: 'json_object' })
})

// ── Inbound ─────────────────────────────────────────────────────

test('deepseek: rewrites usage prompt_cache_hit/miss into prompt_tokens_details.cached_tokens', async () => {
  const i = inv({ model: 'deepseek-reasoner', messages: [] })
  const chunk = {
    id: 'x',
    object: 'chat.completion.chunk' as const,
    created: 0,
    model: 'deepseek-test',
    choices: [],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 70,
      prompt_cache_miss_tokens: 30,
    } as unknown as ChatCompletionsStreamEvent['usage'],
  } satisfies ChatCompletionsStreamEvent
  const result = await withVendorDeepSeekChatCompletionsNormalize(i, baseCtx, () =>
    Promise.resolve(
      llmEventResult(
        (async function* () {
          yield eventFrame(chunk)
        })() as AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
        stubIdentity,
      ),
    ),
  )
  const frames = await collect(result)
  const f = frames[0]!
  if (f.type !== 'event') throw new Error('expected event')
  const usage = f.event.usage as unknown as Record<string, unknown>
  expect(usage.prompt_tokens).toBe(100)
  expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 70 })
  expect('prompt_cache_hit_tokens' in usage).toBe(false)
  expect('prompt_cache_miss_tokens' in usage).toBe(false)
})

// ── Pass-through ────────────────────────────────────────────────

test('deepseek: leaves done frames untouched', async () => {
  const i = inv({ model: 'deepseek-reasoner', messages: [] })
  const done = doneFrame() as ProtocolFrame<ChatCompletionsStreamEvent>
  const result = await withVendorDeepSeekChatCompletionsNormalize(i, baseCtx, () =>
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

test('deepseek: early-returns when flag is not set', async () => {
  const i = inv(
    {
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none',
    },
    new Set(),
  )
  await withVendorDeepSeekChatCompletionsNormalize(i, baseCtx, okRun)
  expect(i.payload.reasoning_effort).toBe('none')
  expect(i.payload.thinking).toBeUndefined()
})
