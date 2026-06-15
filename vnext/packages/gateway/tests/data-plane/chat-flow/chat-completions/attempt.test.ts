// vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/attempt.test.ts
import { test, expect, mock } from 'bun:test'
import { chatCompletionsAttempt } from '../../../../src/data-plane/chat-flow/chat-completions/attempt'
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

const identityTranslator = { translateRequest: (p: unknown) => p } as any

test('case a — same-protocol leaf returns EventResult on provider 200', async () => {
  const fetchMock = mock(async () => makeProviderResponse({ status: 200, body: okSseBody }))
  const fakeBinding = { provider: { fetch: fetchMock } } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    raw: new Request('http://x', { method: 'POST', body: '{}' }),
    auth: baseAuth,
    ctx: baseCtx,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator }),
    dispatchFallback: async () => { throw new Error('should not be called') },
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
  const fakeBinding = { provider: { fetch: fetchMock } } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    raw: new Request('http://x'),
    auth: baseAuth,
    ctx: baseCtx,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator }),
    dispatchFallback: async () => new Response(),
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
  const fakeBinding = { provider: { fetch: fetchMock } } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    raw: new Request('http://x'),
    auth: baseAuth,
    ctx: baseCtx,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator }),
    dispatchFallback: async () => new Response(),
  })
  expect(res.type).toBe('upstream-error')
  if (res.type === 'upstream-error') expect(res.status).toBe(401)
})

test('case d — interceptor throw becomes InternalErrorResult', async () => {
  const fakeBinding = { provider: { fetch: mock(async () => makeProviderResponse({ status: 200, body: okSseBody })) } } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    raw: new Request('http://x'),
    auth: baseAuth,
    ctx: baseCtx,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator }),
    dispatchFallback: async () => new Response(),
    interceptors: [async () => { throw new Error('interceptor-boom') }],
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') expect(String(res.error)).toMatch(/interceptor-boom/)
})

test('case e — cross-protocol target short-circuits to dispatchFallback Response (pass-through)', async () => {
  const fallback = mock(async () => new Response('fallback-body', { status: 200 }))
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'claude', messages: [], stream: true },
    raw: new Request('http://x'),
    auth: baseAuth,
    ctx: baseCtx,
    selectBinding: async () => ({ kind: 'ok', binding: {} as any, targetEndpoint: 'messages', translator: {} as any }),
    dispatchFallback: fallback,
  })
  expect((res as any).kind).toBe('bridged-response')
  if ((res as any).kind === 'bridged-response') {
    expect(await (res as any).response.text()).toBe('fallback-body')
  }
  expect(fallback).toHaveBeenCalledTimes(1)
})

test('case f — model-not-found from selectBinding returns InternalErrorResult(404)', async () => {
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'nope', messages: [] },
    raw: new Request('http://x'),
    auth: baseAuth,
    ctx: baseCtx,
    selectBinding: async () => ({ kind: 'model-not-found', bareModel: 'nope' }),
    dispatchFallback: async () => new Response(),
  })
  expect(res.type).toBe('internal-error')
  if (res.type === 'internal-error') expect(res.status).toBe(404)
})

test('case g — provider returns null body returns InternalErrorResult(502)', async () => {
  const fetchMock = mock(async () => ({ status: 200, headers: new Headers(), body: null }))
  const fakeBinding = { provider: { fetch: fetchMock } } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    raw: new Request('http://x'),
    auth: baseAuth,
    ctx: baseCtx,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator }),
    dispatchFallback: async () => new Response(),
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
  const fakeBinding = { provider: { fetch: fetchMock } } as any

  // Wrapping interceptor: calls next() (which runs terminal and opens the
  // upstream body), then throws BEFORE returning the result to the caller.
  const postLeafThrow = async (_inv: any, _ctx: any, next: () => Promise<unknown>) => {
    await next()
    throw new Error('post-leaf-boom')
  }

  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    raw: new Request('http://x'),
    auth: baseAuth,
    ctx: baseCtx,
    selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: identityTranslator }),
    dispatchFallback: async () => new Response(),
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
