// vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/attempt.test.ts
import { test, expect, mock } from 'bun:test'
import { chatCompletionsAttempt } from '../../../../src/data-plane/chat-flow/chat-completions/attempt'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx'
import type { RequestContext } from '@vnext/interceptor'

type FakeProviderResponse = {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array>
}

const makeProviderResponse = (init: { status: number; body: string; contentType?: string }): FakeProviderResponse => ({
  status: init.status,
  headers: new Headers({ 'content-type': init.contentType ?? 'text/event-stream' }),
  body: new Response(init.body).body!,
})

const okSseBody =
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n'

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
// Minimal binding shape so attempt-helpers can build a model identity without
// us mocking the full ProviderBinding ceremony.
const fakeBindingBase = {
  upstream: 'fake',
  model: { id: 'gpt-x' },
  provider: { getPricingForModelKey: () => null },
}

const identityTranslator = { translateRequest: (p: unknown) => p } as any

test('case a — same-protocol leaf returns EventResult on provider 200', async () => {
  const fetchMock = mock(async () => makeProviderResponse({ status: 200, body: okSseBody }))
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator, bareModel: 'gpt-x' }),
  })
  expect(res.type).toBe('events')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('case b — interceptor sees mutated payload before terminal (include_usage)', async () => {
  let leafSawPayload: any = null
  const fetchMock = mock(async (req: any) => {
    leafSawPayload = req.payload
    return makeProviderResponse({ status: 200, body: okSseBody })
  })
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator, bareModel: 'gpt-x' }),
  })
  // Drain the stream so the lazy interceptor work runs to completion.
  if (res.type === 'events') {
    for await (const _ of res.events) { /* drain */ }
  }
  expect(leafSawPayload.stream_options).toEqual({ include_usage: true })
})

test('case c — provider 401 returns UpstreamErrorResult', async () => {
  const fetchMock = mock(async () =>
    makeProviderResponse({ status: 401, body: '{"error":"unauth"}', contentType: 'application/json' }),
  )
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator, bareModel: 'gpt-x' }),
  })
  expect(res.type).toBe('upstream-error')
  if (res.type === 'upstream-error') expect(res.status).toBe(401)
})

test('case d — interceptor throw becomes InternalErrorResult', async () => {
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: mock(async () => makeProviderResponse({ status: 200, body: okSseBody })) } } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator, bareModel: 'gpt-x' }),
    interceptors: [async () => { throw new Error('interceptor-boom') }],
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') expect(String(res.error)).toMatch(/interceptor-boom/)
})

test('case e — cross-protocol target returns InternalErrorResult(501) (deferred to Spec 6)', async () => {
  // The legacy `dispatch()` bridge was deleted in Spec 3 Part 4 — native
  // cross-protocol attempts (chat_completions → messages, etc.) are deferred
  // to Spec 6. Until then, the attempt surfaces a 501-shaped internal-error
  // so the failure mode is loud and telemetry accounts for the abandoned
  // response.
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'claude', messages: [], stream: true },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: {} as any, targetEndpoint: 'messages', translator: {} as any, bareModel: 'claude' }),
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') {
    expect(res.status).toBe(501)
    expect(String(res.error)).toMatch(/cross-protocol/)
  }
})

test('case f — model-not-found from selectBinding returns InternalErrorResult(404)', async () => {
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'nope', messages: [] },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'model-not-found', bareModel: 'nope' }),
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') expect(res.status).toBe(404)
})

test('case g — provider returns null body returns InternalErrorResult(502)', async () => {
  const fetchMock = mock(async () => ({ status: 200, headers: new Headers(), body: null }))
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator, bareModel: 'gpt-x' }),
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') {
    expect(res.status).toBe(502)
    expect(String(res.error)).toMatch(/empty body/)
  }
})

test('case h — interceptor throw AFTER terminal cancels upstream stream body', async () => {
  // Build a body whose cancel() we can observe. The interceptor below wraps
  // terminal so it can throw post-leaf, after terminal has opened resp.body.
  const cancelSpy = mock(async () => {})
  const baseBody = new Response(okSseBody).body!
  const observableBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = baseBody.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) { controller.close(); break }
        controller.enqueue(value)
      }
    },
    async cancel(reason) {
      await cancelSpy(reason)
      try { await baseBody.cancel(reason) } catch { /* may already be locked */ }
    },
  })
  const fetchMock = mock(async () => ({
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: observableBody,
  }))
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as any

  // Wrapping interceptor: calls next() (which runs terminal and opens the
  // upstream body), then throws BEFORE returning the result to the caller.
  const postLeafThrow = async (_inv: any, _ctx: any, next: () => Promise<unknown>) => {
    await next()
    throw new Error('post-leaf-boom')
  }

  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator, bareModel: 'gpt-x' }),
    interceptors: [postLeafThrow as any],
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') {
    expect(res.status).toBe(502)
    expect(String(res.error)).toMatch(/post-leaf-boom/)
  }
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(cancelSpy).toHaveBeenCalledTimes(1)
})

test('case i — inheritedHeaders are merged into invocation before terminal', async () => {
  // Spec 6 Part 2 Task 1: when a calling cross-protocol attempt seeds the inner
  // attempt with `inheritedHeaders`, those entries must appear on the upstream
  // ProviderRequest. The merge happens via the existing
  // `for ... Object.entries(invocation.headers) ... headers.set(...)` loop in
  // terminal — once `invocation.headers` is seeded with inherited values they
  // flow through unchanged.
  let captured: Headers | null = null
  const fetchMock = mock(async (req: any) => {
    captured = req.headers as Headers
    return makeProviderResponse({ status: 200, body: okSseBody })
  })
  const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    auth: baseAuth,
    ctx: baseCtx,
    telemetryCtx: baseTelemetry,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator, bareModel: 'gpt-x' }),
    inheritedHeaders: { 'x-trace-id': 'abc' },
  })
  expect(res.type).toBe('events')
  expect(captured).not.toBeNull()
  expect(captured!.get('x-trace-id')).toBe('abc')
})
