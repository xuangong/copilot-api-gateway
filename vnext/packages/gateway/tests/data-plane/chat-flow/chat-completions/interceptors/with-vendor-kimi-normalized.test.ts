import { test, expect } from 'bun:test'
import { withVendorKimiChatCompletionsNormalize } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors/with-vendor-kimi-normalized'
import type {
  Invocation,
  RequestContext,
  LlmExecuteResult,
  TelemetryModelIdentity,
} from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'
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
  enabledFlags: ReadonlySet<string> = new Set(['vendor-kimi']),
): Invocation => ({
  endpoint: 'chat_completions',
  enabledFlags,
  sourceApi: 'chat_completions',
  payload,
  headers: {},
})

const collect = async (
  result: LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>,
): Promise<ProtocolFrame<ChatCompletionsStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events')
  const out: ProtocolFrame<ChatCompletionsStreamEvent>[] = []
  for await (const frame of result.events) out.push(frame)
  return out
}

const usageChunk: ChatCompletionsStreamEvent = {
  id: 'x',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'kimi-test',
  choices: [],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    cached_tokens: 50,
  } as unknown as ChatCompletionsStreamEvent['usage'],
}

test('kimi: rewrites flat cached_tokens → prompt_tokens_details.cached_tokens', async () => {
  const i = inv({ model: 'kimi-k2', messages: [{ role: 'user', content: 'hi' }] })
  const result = await withVendorKimiChatCompletionsNormalize(i, baseCtx, () =>
    Promise.resolve(
      llmEventResult(
        (async function* () {
          yield eventFrame(usageChunk)
        })() as AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
        stubIdentity,
      ),
    ),
  )
  const frames = await collect(result)
  expect(frames.length).toBe(1)
  const f = frames[0]!
  if (f.type !== 'event') throw new Error('expected event')
  const usage = f.event.usage as unknown as Record<string, unknown>
  expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 50 })
  expect('cached_tokens' in usage).toBe(false)
})

test('kimi: early-returns when flag is not set', async () => {
  const i = inv({ model: 'kimi-k2', messages: [{ role: 'user', content: 'hi' }] }, new Set())
  const result = await withVendorKimiChatCompletionsNormalize(i, baseCtx, () =>
    Promise.resolve(
      llmEventResult(
        (async function* () {
          yield eventFrame(usageChunk)
        })() as AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
        stubIdentity,
      ),
    ),
  )
  const frames = await collect(result)
  const f = frames[0]!
  if (f.type !== 'event') throw new Error('expected event')
  const usage = f.event.usage as unknown as Record<string, unknown>
  expect(usage.cached_tokens).toBe(50)
  expect('prompt_tokens_details' in usage).toBe(false)
})
