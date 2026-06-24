// vnext/packages/gateway/tests/data-plane/chat-flow/responses/attempt.test.ts
//
// Spec 6 Part 3 Task 3: responses/attempt.ts must merge `inheritedHeaders` into
// the upstream ProviderRequest. These tests inject a fake binding whose
// provider.fetch captures the request and asserts the inherited values flowed
// through unchanged.
//
// Note: responses/attempt.ts has an image-generation shortcut that runs BEFORE
// binding selection. Tests use a non-image-gen payload (no tools with type:
// 'image_generation') to avoid that path.

import { test, expect, mock } from 'bun:test'
import { responsesAttempt } from '../../../../src/data-plane/chat-flow/responses/attempt'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx'
import type { RequestContext } from '@vnext-llm/protocols/common'

type FakeProviderResponse = {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array>
}

const makeProviderResponse = (init: { status: number; body: string; contentType?: string }): FakeProviderResponse => ({
  status: init.status,
  headers: new Headers({ 'content-type': init.contentType ?? 'application/json' }),
  body: new Response(init.body).body!,
})

// A minimal non-streaming responses JSON body. The Responses reassembler looks
// for a terminal `response.completed` frame, so we construct a valid ResponsesResult.
const okJsonBody = JSON.stringify({
  id: 'resp_test',
  object: 'response',
  status: 'completed',
  model: 'gpt-4o',
  output: [{ type: 'message', id: 'item_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
})

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

// Minimal binding shape — only provider.fetch + fields needed by attempt-helpers.
const fakeBindingBase = {
  upstream: 'fake',
  model: { id: 'gpt-4o' },
  provider: { getPricingForModelKey: () => null },
}

const identityTranslator = { translateRequest: (p: unknown) => p } as never

test('case a — same-protocol leaf returns LlmEventResult on provider 200', async () => {
  const fetchMock = mock(async () => makeProviderResponse({ status: 200, body: okJsonBody }))
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as never
  const res = await responsesAttempt.generate({
    payload: { model: 'gpt-4o', input: [], stream: false },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'responses', translator: identityTranslator, bareModel: 'gpt-4o' }),
  })
  expect(res.type).toBe('events')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('case b — inheritedHeaders are merged into upstream ProviderRequest headers', async () => {
  // Spec 6 Part 3 Task 3: when `inheritedHeaders` is passed in ResponsesAttemptArgs,
  // those entries must appear on the upstream ProviderRequest.headers because the
  // Invocation is seeded with them and the terminal loops `Object.entries(invocation.headers)`.
  let captured: Headers | null = null
  const fetchMock = mock(async (req: { headers: Headers }) => {
    captured = req.headers
    return makeProviderResponse({ status: 200, body: okJsonBody })
  })
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as never
  const res = await responsesAttempt.generate({
    payload: { model: 'gpt-4o', input: [], stream: false },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'responses', translator: identityTranslator, bareModel: 'gpt-4o' }),
    inheritedHeaders: { 'x-copilot-thread-id': 'thread-xyz', 'x-custom-header': 'value-456' },
  })
  expect(res.type).toBe('events')
  expect(captured).not.toBeNull()
  expect(captured!.get('x-copilot-thread-id')).toBe('thread-xyz')
  expect(captured!.get('x-custom-header')).toBe('value-456')
})

test('case c — model-not-found from selectBinding returns InternalErrorResult(404)', async () => {
  const res = await responsesAttempt.generate({
    payload: { model: 'nope', input: [] },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'model-not-found', bareModel: 'nope' }),
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') expect(res.status).toBe(404)
})

test('case d — provider 401 returns UpstreamErrorResult', async () => {
  const fetchMock = mock(async () =>
    makeProviderResponse({ status: 401, body: '{"error":{"type":"authentication_error","message":"unauth"}}', contentType: 'application/json' }),
  )
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as never
  const res = await responsesAttempt.generate({
    payload: { model: 'gpt-4o', input: [], stream: false },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'responses', translator: identityTranslator, bareModel: 'gpt-4o' }),
  })
  expect(res.type).toBe('upstream-error')
  if (res.type === 'upstream-error') expect(res.status).toBe(401)
})

test('case e — provider returns null body returns InternalErrorResult(502)', async () => {
  const fetchMock = mock(async () => ({ status: 200, headers: new Headers(), body: null }))
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as never
  const res = await responsesAttempt.generate({
    payload: { model: 'gpt-4o', input: [], stream: false },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'responses', translator: identityTranslator, bareModel: 'gpt-4o' }),
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') {
    expect(res.status).toBe(502)
    expect(String(res.error)).toMatch(/empty body/)
  }
})
