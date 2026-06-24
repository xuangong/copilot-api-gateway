// vnext/packages/gateway/tests/data-plane/chat-flow/messages/attempt.cross.test.ts
//
// Spec 6 Part 3 Task 2: messages source attempt must dispatch cross-protocol
// targets (`responses`, `chat_completions`) via `traverseTranslation`, not
// surface a 501. These tests inject a fake hub attempt + fake translator and
// assert the translatorPair lands on the resulting modelIdentity.

import { test, expect, mock } from 'bun:test'
import { messagesAttempt } from '../../../../src/data-plane/chat-flow/messages/attempt'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx'
import type { RequestContext } from '@vnext-llm/protocols/common'
import { llmEventResult } from '@vnext-llm/protocols/common'
import { type ProtocolFrame } from '@vnext-gateway/result'

const baseCtx: RequestContext = { requestStartedAt: Date.now() }
const baseAuth = { ownerId: 'o', copilot: false }
const baseTelemetry: TelemetryRequestContext = {
  apiKeyId: 'k',
  userAgent: 'ua',
  requestId: 'rid',
  isStreaming: false,
  runtimeLocation: 'bun',
  requestStartedAt: Date.now(),
}

// Fake binding stub — the cross-protocol path passes the binding to
// traverseTranslation only via `fallbackMaxOutputTokens`, so the shape can
// be minimal here.
const fakeBindingBase = {
  upstream: 'fake',
  model: { id: 'claude-x' },
  upstreamMaxOutputTokens: 4096,
  provider: { getPricingForModelKey: () => null },
}

// Helper: a fake hub-protocol frame iterable. The translator's translateEvents
// is the identity function in these tests, so frames flow through unchanged.
async function* hubFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
  yield { kind: 'event', protocol: 'responses', data: { sentinel: 'hub-frame' } } as never
}

// Translator stub: identity request translation, identity event translation,
// identity body translation. Real translators would shape the payload — for
// these tests we only care about wiring.
const makeTranslator = () =>
  ({
    translateRequest: mock(async (payload: unknown) => payload),
    translateEvents: mock((events: AsyncIterable<unknown>) => events),
    translateBody: mock(async (body: unknown) => body),
  }) as never

test('cross-protocol messages → responses dispatches via traverseTranslation', async () => {
  const translator = makeTranslator()
  // Fake hub attempt: returns an LlmEventResult so traverseTranslation enters the
  // events branch and stamps translatorPair onto modelIdentity.
  const hubGenerate = mock(async () =>
    llmEventResult(
      hubFrames() as never,
      { upstream: 'fake', upstreamModel: 'gpt-x', sourceModel: 'gpt-x' },
      undefined,
      undefined,
      undefined,
    ),
  )
  const hubAttemptOverride = mock((_p: 'chat_completions' | 'messages' | 'responses') => ({ generate: hubGenerate }))

  const res = await messagesAttempt.generate({
    payload: { model: 'claude-x', messages: [], stream: false },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({
      kind: 'ok',
      binding: fakeBindingBase as never,
      targetEndpoint: 'responses',
      translator,
      bareModel: 'claude-x',
    }),
    hubAttemptOverride: hubAttemptOverride as never,
  })

  expect(res.type).toBe('events')
  if (res.type === 'events') {
    expect(res.modelIdentity.translatorPair).toEqual({ source: 'messages', hub: 'responses' })
  }
  expect(hubAttemptOverride).toHaveBeenCalledTimes(1)
  expect(hubAttemptOverride).toHaveBeenCalledWith('responses')
  expect(hubGenerate).toHaveBeenCalledTimes(1)
})

test('cross-protocol messages → chat_completions dispatches via traverseTranslation', async () => {
  const translator = makeTranslator()
  const hubGenerate = mock(async () =>
    llmEventResult(
      hubFrames() as never,
      { upstream: 'fake', upstreamModel: 'gpt-4', sourceModel: 'gpt-4' },
      undefined,
      undefined,
      undefined,
    ),
  )
  const hubAttemptOverride = mock((_p: 'chat_completions' | 'messages' | 'responses') => ({ generate: hubGenerate }))

  const res = await messagesAttempt.generate({
    payload: { model: 'claude-x', messages: [], stream: false },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({
      kind: 'ok',
      binding: fakeBindingBase as never,
      targetEndpoint: 'chat_completions',
      translator,
      bareModel: 'claude-x',
    }),
    hubAttemptOverride: hubAttemptOverride as never,
  })

  expect(res.type).toBe('events')
  if (res.type === 'events') {
    expect(res.modelIdentity.translatorPair).toEqual({ source: 'messages', hub: 'chat_completions' })
  }
  expect(hubAttemptOverride).toHaveBeenCalledTimes(1)
  expect(hubAttemptOverride).toHaveBeenCalledWith('chat_completions')
  expect(hubGenerate).toHaveBeenCalledTimes(1)
})
