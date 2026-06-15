// vnext/packages/gateway/tests/data-plane/chat-flow/gemini/attempt.test.ts
/**
 * Minimal module-existence + happy-path coverage for `geminiAttempt`. End-to-end
 * gemini → respond → SSE wiring lives in the integration battery (P4.T5).
 *
 * Gemini source ALWAYS cross-protocol bridges (per `pair-selector.ts`
 * PREFERENCE: messages → responses → chat_completions). There's no
 * gemini-shape hub target and no `bridged-response` sentinel — every binding
 * selection must produce a target + translator and the attempt drives the
 * upstream call directly. The cases below pin both:
 *   1. the module surface exists and binds successfully on a clean input
 *   2. cross-protocol target (messages) reaches provider.fetch and yields
 *      bare-event EventResult that respond.ts can consume
 *   3. selection-failure 4xx paths surface as internal-error (without
 *      performance ctx per Spec 3 §6.2)
 */
import { test, expect, mock } from 'bun:test'
import { geminiAttempt } from '../../../../src/data-plane/chat-flow/gemini/attempt'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx'
import type { RequestContext } from '@vnext/interceptor'

type FakeProviderResponse = {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

const makeProviderResponse = (init: { status: number; body: string; contentType?: string }): FakeProviderResponse => ({
  status: init.status,
  headers: new Headers({ 'content-type': init.contentType ?? 'text/event-stream' }),
  body: new Response(init.body).body!,
})

// Minimal hub-shape SSE that survives parseMessagesStream without producing
// any usage. We don't care about the events — only that the pipeline reaches
// `eventResult` and respond.ts can drain.
const okMessagesSse =
  'event: message_start\n' +
  'data: {"type":"message_start","message":{"id":"m","role":"assistant","content":[],"model":"gemini-x","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
  'event: message_stop\n' +
  'data: {"type":"message_stop"}\n\n'

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
  provider: { getPricingForModelKey: () => null },
}
// Identity translator that mirrors what PAIR_GEMINI_TO_MESSAGES does for
// translateEvents (yields the bare hub events back without reshaping). The
// test only cares the pipeline reaches and drains a stream.
const passthroughTranslator = {
  translateRequest: (p: unknown) => p,
  translateEvents: async function* (events: AsyncIterable<unknown>) {
    for await (const e of events) yield e
  },
  translateBody: (b: unknown) => b,
} as any

test('module surface exists', () => {
  expect(typeof geminiAttempt.generate).toBe('function')
})

test('happy path — bridges gemini → messages target and yields EventResult', async () => {
  const fetchMock = mock(async () => makeProviderResponse({ status: 200, body: okMessagesSse }))
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as any
  const res = await geminiAttempt.generate({
    payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } as any,
    model: 'gemini-x',
    forceStream: true,
    raw: new Request('http://internal/v1beta/models/gemini-x:streamGenerateContent', { method: 'POST', body: '{}' }),
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
  })
  expect(res.type).toBe('events')
  // Drain to ensure the lazy pipeline runs without throwing.
  if (res.type === 'events') {
    for await (const _ of res.events) { /* drain */ }
  }
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const callArgs = fetchMock.mock.calls[0]![0] as { endpoint: string; flags?: { isStreaming?: boolean } }
  expect(callArgs.endpoint).toBe('messages')
  // forceStream=true ⇒ provider sees isStreaming=true even though payload has
  // no `stream` field (gemini wire doesn't carry one).
  expect(callArgs.flags?.isStreaming).toBe(true)
})

test('model-not-found returns 404 internal-error without performance ctx', async () => {
  const res = await geminiAttempt.generate({
    payload: { contents: [] } as any,
    model: 'no-such-model',
    forceStream: false,
    raw: new Request('http://internal/v1beta/models/no-such-model:generateContent', { method: 'POST', body: '{}' }),
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
    raw: new Request('http://internal/v1beta/models/gemini-x:generateContent', { method: 'POST', body: '{}' }),
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
    raw: new Request('http://internal/v1beta/models/gemini-x:generateContent', { method: 'POST', body: '{}' }),
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'no-translator', bareModel: 'gemini-x', targetEndpoint: 'messages' }),
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') expect(res.status).toBe(500)
})

test('upstream non-2xx surfaces upstream-error with performance ctx', async () => {
  const fetchMock = mock(async () => makeProviderResponse({
    status: 429,
    body: JSON.stringify({ error: { message: 'slow down' } }),
    contentType: 'application/json',
  }))
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as any
  const res = await geminiAttempt.generate({
    payload: { contents: [] } as any,
    model: 'gemini-x',
    forceStream: false,
    raw: new Request('http://internal/v1beta/models/gemini-x:generateContent', { method: 'POST', body: '{}' }),
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
  })
  expect(res.type).toBe('upstream-error')
  if (res.type === 'upstream-error') {
    expect(res.status).toBe(429)
    // Post-binding errors carry performance ctx so recordPerformance writes isError=true.
    expect(res.performance).toBeDefined()
  }
})
