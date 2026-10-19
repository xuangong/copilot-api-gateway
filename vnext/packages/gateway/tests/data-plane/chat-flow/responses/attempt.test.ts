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

import { test, expect, mock, spyOn } from 'bun:test'
import { responsesAttempt } from '../../../../src/data-plane/chat-flow/responses/attempt'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx'
import type { RequestContext } from '@vibe-llm/protocols/common'

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
  incomingModel: 'responses-alias',
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

for (const { stream, topLevelError } of [
  { stream: true, topLevelError: false },
  { stream: false, topLevelError: false },
  { stream: true, topLevelError: true },
]) {
  test(`failed Responses diagnostics preserve the error and omit private data (stream=${stream}, topLevelError=${topLevelError})`, async () => {
    const error = { code: 'server_error', message: 'Maximum context length exceeded: private prompt and sk-secret', details: 'private details' }
    const responseError = topLevelError ? null : error
    const response = { id: 'private-response-id', object: 'response', status: 'failed', model: 'gpt-4o', output: [], error: responseError }
    const terminal = { type: 'response.failed', response, ...(topLevelError ? { error } : {}) }
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await responsesAttempt.generate({
        payload: {
          model: 'gpt-4o', stream, instructions: 'private instructions',
          input: [
            { role: 'user', content: 'private input' },
            { type: 'compaction', encrypted_content: 'private blob' },
            { type: 'function_call', name: 'private tool', arguments: '{}' },
            { type: 'function_call_output', output: 'private output' },
          ],
          tools: [{ type: 'function', name: 'private tool' }],
          max_output_tokens: 4096,
        },
        auth: baseAuth, ctx: baseCtx, telemetryCtx: baseTelemetry,
        selectBinding: async () => ({
          kind: 'ok', targetEndpoint: 'responses', translator: identityTranslator, bareModel: 'gpt-4o',
          binding: {
            ...fakeBindingBase,
            model: { id: 'gpt-4o', limits: { maxContextWindowTokens: 128000, maxPromptTokens: 120000 } },
            provider: {
              ...fakeBindingBase.provider,
              fetch: async () => makeProviderResponse({
                status: 200,
                body: stream ? `event: response.failed\ndata: ${JSON.stringify(terminal)}\n\n` : JSON.stringify(response),
                contentType: stream ? 'text/event-stream' : 'application/json',
              }),
            },
          },
        }),
      })
      if (!('type' in result) || result.type !== 'events') throw new Error('expected events')
      const events = []
      for await (const frame of result.events) events.push(frame)
      expect(events).toContainEqual(expect.objectContaining({
        type: 'event', event: expect.objectContaining({ type: 'response.failed', response: expect.objectContaining({ error: responseError }) }),
      }))
      expect(warn.mock.calls).toEqual([[expect.objectContaining({
        event: 'upstream_response_failed', request_id: 'rid', upstream: 'fake', model: 'gpt-4o',
        error_code: 'server_error', error_message_present: true,
        diagnostic_stage: stream ? 'upstream_sse' : 'upstream_json',
        error_location: topLevelError ? 'event.error' : 'response.error',
        error_message_kind: 'context_limit',
        input_items: 4, compaction_items: 1, tool_call_items: 1, tool_output_items: 1,
        tool_count: 1, instructions_chars: 20, max_output_tokens: 4096,
        max_context_window_tokens: 128000, max_prompt_tokens: 120000,
        previous_response_id_present: false,
      })]])
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private')
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-secret')
    } finally { warn.mockRestore() }
  })
}

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
  if (res.type === 'events') {
    expect(res.modelIdentity).toMatchObject({ incomingModel: 'responses-alias', model: 'gpt-4o' })
  }
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

// `Invocation.sourceApi` names the protocol the *client* speaks, not the one
// this attempt runs. A chat-completions / messages / gemini request routed to a
// Responses upstream re-enters this same attempt through `traverseTranslation`,
// and interceptors that behave differently for a native caller — the web-search
// shim stands aside only when the client can read `web_search_call` items
// itself — have no other way to tell the two apart. `telemetryCtx.sourceApi` is
// the one value threaded intact across the translation hop, so it is the source
// of truth here, exactly as in messages/attempt.ts.
test('case f — sourceApi reports the inbound protocol, not this attempt', async () => {
  const seen: Array<string | undefined> = []
  const capture = (async (invocation: { sourceApi?: string }, _ctx: unknown, run: () => unknown) => {
    seen.push(invocation.sourceApi)
    return await run()
  }) as never

  for (const inbound of ['chat-completions', 'messages', 'gemini', 'responses', undefined] as const) {
    const fetchMock = mock(async () => makeProviderResponse({ status: 200, body: okJsonBody }))
    const fakeBinding = { ...fakeBindingBase, provider: { ...fakeBindingBase.provider, fetch: fetchMock } } as never
    await responsesAttempt.generate({
      payload: { model: 'gpt-4o', input: [], stream: false },
      auth: baseAuth,
      ctx: baseCtx,
      telemetryCtx: { ...baseTelemetry, ...(inbound !== undefined ? { sourceApi: inbound } : {}) },
      interceptors: [capture],
      selectBinding: async () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'responses', translator: identityTranslator, bareModel: 'gpt-4o' }),
    })
  }

  // A caller that predates the telemetry field is treated as native, so the
  // behaviour of every existing call site is unchanged.
  expect(seen).toEqual(['chat_completions', 'messages', 'gemini', 'responses', 'responses'])
})
