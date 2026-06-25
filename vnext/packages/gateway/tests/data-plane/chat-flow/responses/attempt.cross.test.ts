// vnext/packages/gateway/tests/data-plane/chat-flow/responses/attempt.cross.test.ts
//
// Spec 6 Part 3 Task 4: responses source attempt must dispatch cross-protocol
// targets (`messages`, `chat_completions`) via `traverseTranslation`, not
// surface a 501. These tests inject a fake hub attempt + fake translator and
// assert the translatorPair lands on the resulting modelIdentity.

import { test, expect, mock } from 'bun:test'
import { responsesAttempt } from '../../../../src/data-plane/chat-flow/responses/attempt'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx'
import type { RequestContext } from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import { type ProtocolFrame } from '@vibe-core/result'

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
  model: { id: 'gpt-x' },
  upstreamMaxOutputTokens: 4096,
  provider: { getPricingForModelKey: () => null },
}

// Helper: a fake hub-protocol frame iterable.
async function* hubFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
  yield { kind: 'event', protocol: 'messages', data: { sentinel: 'hub-frame' } } as never
}

// Translator stub: identity translations for all three hooks.
const makeTranslator = () =>
  ({
    translateRequest: mock(async (payload: unknown) => payload),
    translateEvents: mock((events: AsyncIterable<unknown>) => events),
    translateBody: mock(async (body: unknown) => body),
  }) as never

test('cross-protocol responses → messages dispatches via traverseTranslation', async () => {
  const translator = makeTranslator()
  // Fake hub attempt: returns an LlmEventResult so traverseTranslation enters the
  // events branch and stamps translatorPair onto modelIdentity.
  const hubGenerate = mock(async () =>
    llmEventResult(
      hubFrames() as never,
      { upstream: 'fake', upstreamModel: 'claude', sourceModel: 'claude' },
      undefined,
      undefined,
      undefined,
    ),
  )
  const hubAttemptOverride = mock((_p: 'chat_completions' | 'messages' | 'responses') => ({ generate: hubGenerate }))

  const res = await responsesAttempt.generate({
    payload: { model: 'gpt-x', input: [], stream: false },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({
      kind: 'ok',
      binding: fakeBindingBase as never,
      targetEndpoint: 'messages',
      translator,
      bareModel: 'gpt-x',
    }),
    hubAttemptOverride: hubAttemptOverride as never,
  })

  expect(res.type).toBe('events')
  if (res.type === 'events') {
    expect(res.modelIdentity.translatorPair).toEqual({ source: 'responses', hub: 'messages' })
  }
  expect(hubAttemptOverride).toHaveBeenCalledTimes(1)
  expect(hubAttemptOverride).toHaveBeenCalledWith('messages')
  expect(hubGenerate).toHaveBeenCalledTimes(1)
})

test('cross-protocol responses → chat_completions dispatches via traverseTranslation', async () => {
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

  const res = await responsesAttempt.generate({
    payload: { model: 'gpt-x', input: [], stream: false },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({
      kind: 'ok',
      binding: fakeBindingBase as never,
      targetEndpoint: 'chat_completions',
      translator,
      bareModel: 'gpt-x',
    }),
    hubAttemptOverride: hubAttemptOverride as never,
  })

  expect(res.type).toBe('events')
  if (res.type === 'events') {
    expect(res.modelIdentity.translatorPair).toEqual({ source: 'responses', hub: 'chat_completions' })
  }
  expect(hubAttemptOverride).toHaveBeenCalledTimes(1)
  expect(hubAttemptOverride).toHaveBeenCalledWith('chat_completions')
  expect(hubGenerate).toHaveBeenCalledTimes(1)
})
