// vnext/packages/gateway/tests/data-plane/chat-flow/messages/attempt.test.ts
//
// Spec 6 Part 3 Task 1: messages/attempt.ts must merge `inheritedHeaders` into
// the upstream ProviderRequest. These tests inject a fake binding whose
// provider.fetch captures the request and asserts the inherited values flowed
// through unchanged.

import { test, expect, mock } from 'bun:test'
import { messagesAttempt } from '../../../../src/data-plane/chat-flow/messages/attempt'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx'
import type { RequestContext } from '@vnext/protocols/common'

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

// A minimal non-streaming messages JSON body that synthesizeMessagesFramesFromJson
// can handle so the attempt returns an EventResult.
const okJsonBody = JSON.stringify({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'hello' }],
  model: 'claude-opus',
  stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 3 },
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
  model: { id: 'claude-opus' },
  provider: { getPricingForModelKey: () => null },
}

const identityTranslator = { translateRequest: (p: unknown) => p } as never

test('case a — same-protocol leaf returns EventResult on provider 200', async () => {
  const fetchMock = mock(async () => makeProviderResponse({ status: 200, body: okJsonBody }))
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as never
  const res = await messagesAttempt.generate({
    payload: { model: 'claude-opus', messages: [], stream: false },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'messages', translator: identityTranslator, bareModel: 'claude-opus' }),
  })
  expect(res.type).toBe('events')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('case b — inheritedHeaders are merged into upstream ProviderRequest headers', async () => {
  // Spec 6 Part 3 Task 1: when `inheritedHeaders` is passed in MessagesAttemptArgs,
  // those entries must appear on the upstream ProviderRequest.headers because the
  // Invocation is seeded with them and the terminal loops `Object.entries(invocation.headers)`.
  let captured: Headers | null = null
  const fetchMock = mock(async (req: { headers: Headers }) => {
    captured = req.headers
    return makeProviderResponse({ status: 200, body: okJsonBody })
  })
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as never
  const res = await messagesAttempt.generate({
    payload: { model: 'claude-opus', messages: [], stream: false },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'messages', translator: identityTranslator, bareModel: 'claude-opus' }),
    inheritedHeaders: { 'x-copilot-thread-id': 'thread-abc', 'x-custom-header': 'value-123' },
  })
  expect(res.type).toBe('events')
  expect(captured).not.toBeNull()
  expect(captured!.get('x-copilot-thread-id')).toBe('thread-abc')
  expect(captured!.get('x-custom-header')).toBe('value-123')
})

test('case c — model-not-found from selectBinding returns InternalErrorResult(404)', async () => {
  const res = await messagesAttempt.generate({
    payload: { model: 'nope', messages: [] },
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
    makeProviderResponse({ status: 401, body: '{"type":"error","error":{"type":"authentication_error","message":"unauth"}}', contentType: 'application/json' }),
  )
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as never
  const res = await messagesAttempt.generate({
    payload: { model: 'claude-opus', messages: [], stream: false },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'messages', translator: identityTranslator, bareModel: 'claude-opus' }),
  })
  expect(res.type).toBe('upstream-error')
  if (res.type === 'upstream-error') expect(res.status).toBe(401)
})

test('case e — provider returns null body returns InternalErrorResult(502)', async () => {
  const fetchMock = mock(async () => ({ status: 200, headers: new Headers(), body: null }))
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as never
  const res = await messagesAttempt.generate({
    payload: { model: 'claude-opus', messages: [], stream: false },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'messages', translator: identityTranslator, bareModel: 'claude-opus' }),
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') {
    expect(res.status).toBe(502)
    expect(String(res.error)).toMatch(/empty body/)
  }
})
