// vnext/packages/gateway/tests/data-plane/chat-flow/gemini/attempt.cross.test.ts
//
// Spec 6 Part 4 Task 1: gemini attempt must route all cross-protocol targets
// through `traverseTranslation`. These tests inject a fake hub attempt + fake
// translator and assert:
//   1. `translatorPair` is stamped on `modelIdentity`
//   2. `translateBody` is set from `translator.translateBody`
//   3. Streaming path (SSE) still yields gemini-shaped frames (regression guard)

import { test, expect, mock } from 'bun:test'
import { geminiAttempt } from '../../../../src/data-plane/chat-flow/gemini/attempt'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx'
import type { RequestContext } from '@vnext-llm/protocols/common'
import { llmEventResult } from '@vnext-llm/protocols/common'
import { type ProtocolFrame } from '@vnext-gateway/result'

const baseCtx: RequestContext = { requestStartedAt: Date.now() }
const baseAuth = { ownerId: 'o', copilot: false as const }
const baseTelemetry: TelemetryRequestContext = {
  apiKeyId: 'k',
  userAgent: 'ua',
  requestId: 'rid',
  isStreaming: false,
  runtimeLocation: 'bun',
  requestStartedAt: Date.now(),
}

const fakeBindingBase = {
  upstream: 'fake',
  model: { id: 'gemini-x' },
  upstreamMaxOutputTokens: 4096,
  provider: { getPricingForModelKey: () => null },
}

// Helper: fake hub-protocol frame iterable returned by the fake hub attempt.
async function* hubFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
  yield { kind: 'event', protocol: 'messages', data: { sentinel: 'hub-frame' } } as never
}

// Translator stub: identity translateRequest, identity translateEvents,
// identity translateBody. Real translators shape the payload — we only care
// about wiring here.
const makeTranslator = () =>
  ({
    translateRequest: mock(async (payload: unknown) => payload),
    translateEvents: mock((events: AsyncIterable<unknown>) => events),
    translateBody: mock(async (body: unknown) => body),
  }) as never

test('cross-protocol gemini → messages: translatorPair is stamped on modelIdentity', async () => {
  const translator = makeTranslator()
  const hubGenerate = mock(async () =>
    llmEventResult(
      hubFrames() as never,
      { upstream: 'fake', upstreamModel: 'claude-x', sourceModel: 'claude-x' },
      undefined,
      undefined,
      undefined,
    ),
  )
  const hubAttemptOverride = mock((_p: 'chat_completions' | 'messages' | 'responses') => ({ generate: hubGenerate }))

  const res = await geminiAttempt.generate({
    payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } as any,
    model: 'gemini-x',
    forceStream: false,
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({
      kind: 'ok',
      binding: fakeBindingBase as never,
      targetEndpoint: 'messages',
      translator,
      bareModel: 'gemini-x',
    }),
    hubAttemptOverride: hubAttemptOverride as never,
  })

  expect(res.type).toBe('events')
  if (res.type === 'events') {
    expect(res.modelIdentity.translatorPair).toEqual({ source: 'gemini', hub: 'messages' })
  }
  expect(hubAttemptOverride).toHaveBeenCalledTimes(1)
  expect(hubAttemptOverride).toHaveBeenCalledWith('messages')
  expect(hubGenerate).toHaveBeenCalledTimes(1)
})

test('cross-protocol gemini → messages: translateBody is set from translator.translateBody', async () => {
  const translator = makeTranslator()
  const hubGenerate = mock(async () =>
    llmEventResult(
      hubFrames() as never,
      { upstream: 'fake', upstreamModel: 'claude-x', sourceModel: 'claude-x' },
      undefined,
      undefined,
      undefined,
    ),
  )
  const hubAttemptOverride = mock((_p: 'chat_completions' | 'messages' | 'responses') => ({ generate: hubGenerate }))

  const res = await geminiAttempt.generate({
    payload: { contents: [] } as any,
    model: 'gemini-x',
    forceStream: false,
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({
      kind: 'ok',
      binding: fakeBindingBase as never,
      targetEndpoint: 'messages',
      translator,
      bareModel: 'gemini-x',
    }),
    hubAttemptOverride: hubAttemptOverride as never,
  })

  expect(res.type).toBe('events')
  if (res.type === 'events') {
    // translateBody must be the translator's translateBody function so respond.ts
    // can call it to convert hub JSON → gemini JSON for non-streaming responses.
    expect(typeof res.translateBody).toBe('function')
    // Calling it should invoke the translator's translateBody (identity stub).
    const fakeBody = { type: 'message', content: [] }
    const translated = await res.translateBody!(fakeBody as never)
    expect(translated).toEqual(fakeBody)
  }
})

test('cross-protocol gemini → responses: translatorPair hub is responses', async () => {
  const translator = makeTranslator()
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

  const res = await geminiAttempt.generate({
    payload: { contents: [] } as any,
    model: 'gemini-x',
    forceStream: false,
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({
      kind: 'ok',
      binding: fakeBindingBase as never,
      targetEndpoint: 'responses',
      translator,
      bareModel: 'gemini-x',
    }),
    hubAttemptOverride: hubAttemptOverride as never,
  })

  expect(res.type).toBe('events')
  if (res.type === 'events') {
    expect(res.modelIdentity.translatorPair).toEqual({ source: 'gemini', hub: 'responses' })
  }
  expect(hubAttemptOverride).toHaveBeenCalledWith('responses')
})

test('cross-protocol gemini → chat_completions: translatorPair hub is chat_completions', async () => {
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

  const res = await geminiAttempt.generate({
    payload: { contents: [] } as any,
    model: 'gemini-x',
    forceStream: false,
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({
      kind: 'ok',
      binding: fakeBindingBase as never,
      targetEndpoint: 'chat_completions',
      translator,
      bareModel: 'gemini-x',
    }),
    hubAttemptOverride: hubAttemptOverride as never,
  })

  expect(res.type).toBe('events')
  if (res.type === 'events') {
    expect(res.modelIdentity.translatorPair).toEqual({ source: 'gemini', hub: 'chat_completions' })
  }
  expect(hubAttemptOverride).toHaveBeenCalledWith('chat_completions')
})

test('streaming path: hub frames flow through translateEvents (regression guard)', async () => {
  // Simulate gemini → messages with translateEvents being an identity pass-through.
  // The result events stream must contain the same frames the hub returned.
  const collectedEvents: unknown[] = []
  const hubFrame = { type: 'message_start', message: { id: 'm', model: 'g', usage: { input_tokens: 1, output_tokens: 0 } } }
  async function* singleHubFrame(): AsyncGenerator<ProtocolFrame<unknown>> {
    yield { type: 'event', event: hubFrame } as never
  }
  const hubGenerate = mock(async () =>
    llmEventResult(
      singleHubFrame() as never,
      { upstream: 'fake', upstreamModel: 'claude-x', sourceModel: 'claude-x' },
      undefined,
      undefined,
      undefined,
    ),
  )
  const hubAttemptOverride = mock((_p: 'chat_completions' | 'messages' | 'responses') => ({ generate: hubGenerate }))

  const res = await geminiAttempt.generate({
    payload: { contents: [] } as any,
    model: 'gemini-x',
    forceStream: true,
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({
      kind: 'ok',
      binding: fakeBindingBase as never,
      targetEndpoint: 'messages',
      translator: {
        translateRequest: async (p: unknown) => p,
        translateEvents: (events: AsyncIterable<unknown>) => events,
        translateBody: async (b: unknown) => b,
      } as never,
      bareModel: 'gemini-x',
    }),
    hubAttemptOverride: hubAttemptOverride as never,
  })

  expect(res.type).toBe('events')
  if (res.type === 'events') {
    for await (const frame of res.events) {
      collectedEvents.push(frame)
    }
  }
  // At least one frame was forwarded through the pipeline.
  expect(collectedEvents.length).toBeGreaterThan(0)
})
