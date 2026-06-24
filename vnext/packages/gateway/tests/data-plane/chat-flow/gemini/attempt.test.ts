// vnext/packages/gateway/tests/data-plane/chat-flow/gemini/attempt.test.ts
/**
 * Minimal module-existence + happy-path coverage for `geminiAttempt`. End-to-end
 * gemini → respond → SSE wiring lives in the integration battery (P4.T5).
 *
 * Gemini source ALWAYS cross-protocol bridges (per `pair-selector.ts`
 * PREFERENCE: messages → responses → chat_completions). There's no
 * gemini-shape hub target and no `bridged-response` sentinel — every binding
 * selection must produce a target + translator. Since Spec 6 Part 4 Task 1,
 * all attempts flow through `traverseTranslation` + `pickHubAttempt`. Tests
 * use `hubAttemptOverride` to inject a fake hub attempt instead of touching
 * real provider.fetch directly. The cases below pin:
 *   1. the module surface exists and binds successfully on a clean input
 *   2. cross-protocol target (messages) reaches the hub attempt and yields
 *      LlmEventResult that respond.ts can consume
 *   3. selection-failure 4xx paths surface as internal-error (without
 *      performance ctx per Spec 3 §6.2)
 */
import { test, expect, mock } from 'bun:test'
import { geminiAttempt } from '../../../../src/data-plane/chat-flow/gemini/attempt'
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
  isStreaming: true,
  runtimeLocation: 'bun',
  requestStartedAt: Date.now(),
}
const fakeBindingBase = {
  upstream: 'fake',
  model: { id: 'gemini-x' },
  upstreamMaxOutputTokens: 4096,
  provider: { getPricingForModelKey: () => null },
}
// Identity translator — the test only cares the pipeline reaches and drains.
const passthroughTranslator = {
  translateRequest: (p: unknown) => p,
  translateEvents: (events: AsyncIterable<unknown>) => events,
  translateBody: (b: unknown) => b,
} as any

// Minimal hub-shape frame sequence returned by the fake hub attempt.
async function* fakeHubFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
  yield {
    type: 'event',
    event: { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], model: 'gemini-x', usage: { input_tokens: 1, output_tokens: 0 } } },
  } as never
  yield { type: 'event', event: { type: 'message_stop' } } as never
}

test('module surface exists', () => {
  expect(typeof geminiAttempt.generate).toBe('function')
})

test('happy path — bridges gemini → messages target and yields LlmEventResult', async () => {
  const hubGenerate = mock(async () =>
    llmEventResult(
      fakeHubFrames() as never,
      { upstream: 'fake', upstreamModel: 'gemini-x', sourceModel: 'gemini-x' },
      undefined,
      undefined,
      undefined,
    ),
  )
  const hubAttemptOverride = mock((_p: 'chat_completions' | 'messages' | 'responses') => ({ generate: hubGenerate }))
  const fakeBinding = { ...fakeBindingBase } as any
  const res = await geminiAttempt.generate({
    payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } as any,
    model: 'gemini-x',
    forceStream: true,
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({
      kind: 'ok',
      binding: fakeBinding,
      targetEndpoint: 'messages',
      translator: passthroughTranslator,
      bareModel: 'gemini-x',
    }),
    hubAttemptOverride: hubAttemptOverride as never,
  })
  expect(res.type).toBe('events')
  // Drain to ensure the lazy pipeline runs without throwing.
  if (res.type === 'events') {
    for await (const _ of res.events) { /* drain */ }
  }
  expect(hubAttemptOverride).toHaveBeenCalledTimes(1)
  expect(hubAttemptOverride).toHaveBeenCalledWith('messages')
  expect(hubGenerate).toHaveBeenCalledTimes(1)
})

test('model-not-found returns 404 internal-error without performance ctx', async () => {
  const res = await geminiAttempt.generate({
    payload: { contents: [] } as any,
    model: 'no-such-model',
    forceStream: false,
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'model-not-found', bareModel: 'no-such-model' }),
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') {
    expect(res.status).toBe(404)
    // Pre-binding errors omit performance per Spec 3 §6.2.
    expect(res.performance).toBeUndefined()
  }
})

test('no-eligible-binding returns 404 internal-error', async () => {
  const res = await geminiAttempt.generate({
    payload: { contents: [] } as any,
    model: 'gemini-x',
    forceStream: false,
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'no-eligible-binding', bareModel: 'gemini-x' }),
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') expect(res.status).toBe(404)
})

test('no-translator returns 500 internal-error', async () => {
  const res = await geminiAttempt.generate({
    payload: { contents: [] } as any,
    model: 'gemini-x',
    forceStream: false,
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'no-translator', bareModel: 'gemini-x', targetEndpoint: 'messages' }),
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') expect(res.status).toBe(500)
})

test('upstream non-2xx surfaces upstream-error with performance ctx', async () => {
  // Hub attempt returns upstream-error (as the real hub attempt would on non-2xx).
  const hubGenerate = mock(async () => ({
    type: 'upstream-error' as const,
    status: 429,
    body: JSON.stringify({ error: { message: 'slow down' } }),
    performance: { upstream: 'fake', model: 'gemini-x', startedAt: Date.now() } as never,
  }))
  const hubAttemptOverride = mock((_p: 'chat_completions' | 'messages' | 'responses') => ({ generate: hubGenerate }))
  const fakeBinding = { ...fakeBindingBase } as any
  const res = await geminiAttempt.generate({
    payload: { contents: [] } as any,
    model: 'gemini-x',
    forceStream: false,
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({
      kind: 'ok',
      binding: fakeBinding,
      targetEndpoint: 'messages',
      translator: passthroughTranslator,
      bareModel: 'gemini-x',
    }),
    hubAttemptOverride: hubAttemptOverride as never,
  })
  expect(res.type).toBe('upstream-error')
  if (res.type === 'upstream-error') {
    expect(res.status).toBe(429)
    // Post-binding errors carry performance ctx so recordPerformance writes isError=true.
    expect(res.performance).toBeDefined()
  }
})
