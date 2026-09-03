// vnext/packages/gateway/tests/data-plane/chat-flow/gemini/respond.test.ts
/**
 * Coverage for `gemini/respond.ts` — the renderer that converts a
 * `GeminiAttemptResult` (`LlmExecuteResult<unknown>`) into a client `Response`.
 *
 * Two render branches:
 *   - `wantsStream === true`: data-only SSE per gemini convention
 *     (`data: <json>\n\n`, no `event:` prefix, no `[DONE]`).
 *   - `wantsStream === false`: drain stream into a single `GeminiResult`
 *     envelope and emit JSON.
 *
 * Plus error envelope shapes: both the forwarded upstream error and the ones
 * the gateway mints itself go out as Google RPC (`{error:{code,message,status}}`)
 * at the result's status.
 *
 * Telemetry persistence is exercised separately in state-bridge.test.ts —
 * here we omit `telemetryCtx` so no usage/perf rows are required.
 */
import { test, expect, mock } from 'bun:test'
import { setupTestPlatform } from '../../../_setup-platform.ts'
import { respondGemini } from '../../../../src/data-plane/chat-flow/gemini/respond.ts'
import {
  llmEventResult,
  llmInternalErrorResult,
  type TelemetryModelIdentity,
} from '@vibe-llm/protocols/common'
import { type ProtocolFrame } from '@vibe-core/result'
import type { ChatCompletionsStreamEvent } from '@vibe-llm/protocols/chat'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'

const stubIdentity: TelemetryModelIdentity = {
  model: 'gemini-2.5-pro',
  upstream: '<unknown>',
  modelKey: 'gemini-2.5-pro',
  cost: null,
}

const okEvents = async function* (): AsyncGenerator<unknown> {
  yield {
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hi' }] } }],
    modelVersion: 'gemini-2.5-pro',
  }
  yield {
    candidates: [{
      index: 0,
      content: { role: 'model', parts: [{ text: ' there' }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 },
    modelVersion: 'gemini-2.5-pro',
    responseId: 'resp-1',
  }
}

test('events + wantsStream=true → SSE data-only frames, no [DONE]', async () => {
  const resp = await respondGemini(llmEventResult(okEvents(), stubIdentity), { wantsStream: true })
  expect(resp.status).toBe(200)
  expect(resp.headers.get('content-type')).toContain('text/event-stream')
  const body = await resp.text()
  // Each frame is `data: <json>\n\n` — no `event:` prefix, no `[DONE]`.
  expect(body).toContain('data: {')
  expect(body).not.toContain('event: ')
  expect(body).not.toContain('[DONE]')
  expect(body).toContain('"text":"hi"')
  expect(body).toContain('"text":" there"')
  expect(body).toContain('"finishReason":"STOP"')
})

test('Gemini stream and JSON preserve mapped modelVersion and model fields', async () => {
  const identity = { ...stubIdentity, modelKey: 'gemini-2.5-pro-fast', model: 'gemini-2.5-pro-fast' }
  const events = async function* () { yield { candidates: [], modelVersion: 'gemini-2.5-pro', model: 'gemini-2.5-pro' } }
  const stream = await respondGemini(llmEventResult(events(), identity), { wantsStream: true })
  const streamBody = await stream.text()
  expect(streamBody).toContain('"modelVersion":"gemini-2.5-pro-fast"')
  expect(streamBody).toContain('"model":"gemini-2.5-pro-fast"')
  const json = await respondGemini(llmEventResult(events(), identity), { wantsStream: false })
  expect((await json.json() as { modelVersion: string }).modelVersion).toBe('gemini-2.5-pro-fast')
})

test('events + wantsStream=false → JSON envelope with concatenated text + final usage/modelVersion', async () => {
  const resp = await respondGemini(llmEventResult(okEvents(), stubIdentity), { wantsStream: false })
  expect(resp.status).toBe(200)
  expect(resp.headers.get('content-type')).toContain('application/json')
  const json = (await resp.json()) as {
    candidates: Array<{ content: { parts: Array<{ text?: string }> }; finishReason?: string }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    modelVersion?: string
    responseId?: string
  }
  expect(json.candidates).toHaveLength(1)
  expect(json.candidates[0]!.content.parts[0]!.text).toBe('hi there')
  expect(json.candidates[0]!.finishReason).toBe('STOP')
  expect(json.usageMetadata?.promptTokenCount).toBe(5)
  expect(json.usageMetadata?.candidatesTokenCount).toBe(4)
  expect(json.modelVersion).toBe('gemini-2.5-pro')
  expect(json.responseId).toBe('resp-1')
})

// Regression: gateway-minted errors used to go out as a bare
// `{error:{message}}` — the OpenAI shape — while upstream errors on the same
// route were reshaped into Google RPC form. A `@google/genai` client branching
// on `error.status` found it on one and not the other.
test('internal-error → Google RPC envelope, same shape as an upstream error', async () => {
  const resp = await respondGemini(llmInternalErrorResult(404, new Error('model not found: x')), {
    wantsStream: false,
  })
  expect(resp.status).toBe(404)
  expect(resp.headers.get('content-type')).toContain('application/json')
  const json = (await resp.json()) as { error: { code?: number; message?: string; status?: string } }
  expect(json.error?.message).toContain('model not found')
  expect(json.error?.code).toBe(404)
  expect(json.error?.status).toBe('NOT_FOUND')
})

test('internal-error at 500 maps to INTERNAL', async () => {
  const resp = await respondGemini(llmInternalErrorResult(500, new Error('no translator for gemini → responses')), {
    wantsStream: false,
  })
  expect(resp.status).toBe(500)
  const json = (await resp.json()) as { error: { code?: number; status?: string } }
  expect(json.error?.code).toBe(500)
  expect(json.error?.status).toBe('INTERNAL')
})

test('upstream-error → minted gemini error envelope, status preserved', async () => {
  const resp = await respondGemini(
    {
      type: 'upstream-error',
      status: 429,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify({ error: { message: 'slow down' } })),
    },
    { wantsStream: true },
  )
  expect(resp.status).toBe(429)
  // Gemini is the one protocol that still gets reshaped: the upstream body is
  // OpenAI-shaped (no upstream we bind speaks Gemini natively), so forwarding
  // it verbatim would leave the client with no `code` and no `status`.
  const json = (await resp.json()) as { error?: { code?: number; message?: string; status?: string } }
  expect(json.error?.code).toBe(429)
  expect(json.error?.status).toBe('RESOURCE_EXHAUSTED')
  expect(typeof json.error?.message).toBe('string')
})

test('events + wantsStream=false carries non-text parts (functionCall) verbatim', async () => {
  const events = async function* (): AsyncGenerator<unknown> {
    yield {
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [
            { text: 'lookup ' },
            { functionCall: { name: 'getWeather', args: { city: 'sf' } } },
          ],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      modelVersion: 'gemini-2.5-pro',
    }
  }
  const resp = await respondGemini(llmEventResult(events(), stubIdentity), { wantsStream: false })
  const json = (await resp.json()) as {
    candidates: Array<{ content: { parts: Array<{ text?: string; functionCall?: unknown }> } }>
  }
  const parts = json.candidates[0]!.content.parts
  expect(parts.find(p => p.text === 'lookup ')).toBeDefined()
  expect(parts.find(p => p.functionCall !== undefined)).toBeDefined()
})

test('events + wantsStream=false: error frame from translator short-circuits to gemini error envelope', async () => {
  const events = async function* (): AsyncGenerator<unknown> {
    yield { error: { code: 500, message: 'boom', status: 'INTERNAL' } }
  }
  const resp = await respondGemini(llmEventResult(events(), stubIdentity), { wantsStream: false })
  // We render the error frame as the response body verbatim; status 200 because
  // the frame surfaced AFTER the upstream-error gate (mid-stream from the
  // translator's POV). This matches legacy dispatch behaviour.
  expect(resp.status).toBe(200)
  const json = (await resp.json()) as { error: { message: string } }
  expect(json.error.message).toBe('boom')
})

// ─── Spec 6 Part 4 Task 2: translateBody wiring ────────────────────────────
//
// When `translateBody` is set on the LlmEventResult (from `traverseTranslation`),
// the non-streaming branch must:
//   1. Dispatch reassembly to the correct hub reassembler (not reassembleGeminiEvents).
//   2. Call `translateBody(hubJson, ctx)` to convert the hub JSON to gemini JSON.
//   3. Return the translated JSON, not the raw hub-shaped JSON.
//
// Gemini has no native hub — all bindings are cross-protocol.
// Default fallback for hubProtocol is 'chat_completions'.

test('wantsStream=false + translateBody set: invokes translateBody with hub-reassembled JSON', async () => {
  // Simulate a chat_completions hub frame: a [DONE] sentinel after a content chunk.
  const chatFrame1: ProtocolFrame<ChatCompletionsStreamEvent> = {
    type: 'event',
    event: {
      id: 'cmp-1',
      object: 'chat.completion.chunk',
      model: 'gpt-4',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }],
    } as ChatCompletionsStreamEvent,
  }
  const chatFrameDone: ProtocolFrame<ChatCompletionsStreamEvent> = { type: 'done' }

  async function* chatHubFrames(): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
    yield chatFrame1
    yield chatFrameDone
  }

  // translateBody mock: returns a sentinel gemini-shaped object so we can verify
  // it was called with the hub-shaped JSON and its return value is what respond.ts serves.
  const sentinelGeminiJson = {
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
    modelVersion: 'gemini-2.5-pro',
  }
  const translateBody = mock(async (_hubJson: unknown) => sentinelGeminiJson)

  const identity: TelemetryModelIdentity = {
    ...stubIdentity,
    translatorPair: { source: 'gemini', hub: 'chat_completions' },
  }

  const result = llmEventResult(
    chatHubFrames() as unknown as AsyncIterable<unknown>,
    identity,
    undefined,
    undefined,
    translateBody as never,
  )

  const resp = await respondGemini(result, { wantsStream: false })
  expect(resp.status).toBe(200)
  const json = await resp.json()

  // translateBody must have been called (not the legacy reassembleGeminiEvents path)
  expect(translateBody).toHaveBeenCalledTimes(1)
  // The first arg to translateBody should be the hub-shaped chat_completions JSON
  const hubArg = translateBody.mock.calls[0]![0] as { choices?: unknown[] }
  expect(hubArg).toHaveProperty('choices')

  // The response body must be what translateBody returned (gemini-shaped sentinel)
  expect(json).toEqual(sentinelGeminiJson)
})

test('Gemini streaming Responses failure records hub failure before translation', async () => {
  const { repo } = setupTestPlatform()
  const identity: TelemetryModelIdentity = {
    model: 'gemini-public', upstream: 'upstream', modelKey: 'provider-model', cost: null,
    translatorPair: { source: 'gemini', hub: 'responses' },
  }
  async function* hubFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
    yield {
      type: 'event',
      event: {
        type: 'response.failed',
        response: {
          id: 'resp_failed', object: 'response', model: 'provider-model', output: [], status: 'failed',
          error: { code: 'server_error', message: 'upstream unavailable' }, incomplete_details: null,
        },
      },
    }
  }
  async function* translateEvents(events: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    for await (const _event of events) yield { error: { message: 'translated upstream unavailable' } }
  }
  const response = await respondGemini(
    llmEventResult(
      hubFrames(), identity,
      { keyId: 'gemini-stream-responses-failed-key', model: identity.model, modelKey: identity.modelKey, upstream: 'upstream', stream: true, runtimeLocation: 'bun' },
      undefined, undefined, translateEvents,
    ),
    {
      wantsStream: true,
      telemetryCtx: {
        apiKeyId: 'gemini-stream-responses-failed-key' as never, userAgent: null, requestId: 'gemini-stream-responses-failed-request',
        isStreaming: true, runtimeLocation: 'bun', requestStartedAt: Date.now(), sourceApi: 'gemini',
      },
    },
  )
  expect(await response.text()).toContain('translated upstream unavailable')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await repo.usage.query({
    keyId: 'gemini-stream-responses-failed-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })).toEqual([])
  const performance = await repo.performance.query({
    keyId: 'gemini-stream-responses-failed-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(performance.summary).toHaveLength(1)
  expect(performance.summary[0]).toMatchObject({
    model: 'gemini-public', sourceApi: 'gemini', targetApi: 'responses', errors: 1,
  })
})

test('Gemini streaming Messages error records hub failure before translation', async () => {
  const { repo } = setupTestPlatform()
  const identity: TelemetryModelIdentity = {
    model: 'gemini-public', upstream: 'upstream', modelKey: 'provider-model', cost: null,
    translatorPair: { source: 'gemini', hub: 'messages' },
  }
  async function* hubFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
    yield { type: 'event', event: { type: 'error', error: { type: 'api_error', message: 'upstream unavailable' } } }
  }
  async function* translateEvents(events: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    for await (const _event of events) yield { error: { message: 'translated upstream unavailable' } }
  }
  const response = await respondGemini(
    llmEventResult(
      hubFrames(), identity,
      { keyId: 'gemini-stream-messages-failed-key', model: identity.model, modelKey: identity.modelKey, upstream: 'upstream', stream: true, runtimeLocation: 'bun' },
      undefined, undefined, translateEvents,
    ),
    {
      wantsStream: true,
      telemetryCtx: {
        apiKeyId: 'gemini-stream-messages-failed-key' as never, userAgent: null, requestId: 'gemini-stream-messages-failed-request',
        isStreaming: true, runtimeLocation: 'bun', requestStartedAt: Date.now(), sourceApi: 'gemini',
      },
    },
  )
  expect(await response.text()).toContain('translated upstream unavailable')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await repo.usage.query({
    keyId: 'gemini-stream-messages-failed-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })).toEqual([])
  const performance = await repo.performance.query({
    keyId: 'gemini-stream-messages-failed-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(performance.summary).toHaveLength(1)
  expect(performance.summary[0]).toMatchObject({
    model: 'gemini-public', sourceApi: 'gemini', targetApi: 'messages', errors: 1,
  })
})

test('Gemini streaming hub success persists usage exactly once from the provider frame', async () => {
  const { repo } = setupTestPlatform()
  const datedKey = 'provider-model-20260904'
  const identity: TelemetryModelIdentity = {
    model: 'gemini-public', upstream: 'upstream', modelKey: 'provider-model', cost: { input: 1, output: 1 },
    translatorPair: { source: 'gemini', hub: 'responses' },
  }
  async function* hubFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
    const response = {
      id: 'resp_completed', object: 'response', model: datedKey, output: [], status: 'completed',
      error: null, incomplete_details: null, usage: { input_tokens: 7, output_tokens: 3 },
    }
    yield { type: 'event', event: { type: 'response.completed', response } }
  }
  async function* translateEvents(events: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    for await (const _event of events) {
      yield { candidates: [], usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 30 } }
    }
  }
  const response = await respondGemini(
    llmEventResult(
      hubFrames(), identity,
      { keyId: 'gemini-stream-success-key', model: identity.model, modelKey: identity.modelKey, upstream: 'upstream', stream: true, runtimeLocation: 'bun' },
      undefined, undefined, translateEvents,
      (modelKey) => modelKey === datedKey ? { ...identity, modelKey, cost: { input: 2, output: 4 } } : identity,
    ),
    {
      wantsStream: true,
      telemetryCtx: {
        apiKeyId: 'gemini-stream-success-key' as never, userAgent: null, requestId: 'gemini-stream-success-request',
        isStreaming: true, runtimeLocation: 'bun', requestStartedAt: Date.now(), sourceApi: 'gemini',
      },
    },
  )
  expect(await response.text()).toContain('"promptTokenCount":70')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const usage = await repo.usage.query({
    keyId: 'gemini-stream-success-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(usage).toHaveLength(1)
  expect(usage[0]).toMatchObject({
    model: 'gemini-public', modelKey: datedKey, cost: { input: 2, output: 4 }, tokens: { input: 7, output: 3 },
  })
})

test('Gemini nonstream responses hub persists hub usage with public model and provider key', async () => {
  const { repo } = setupTestPlatform()
  const alias = 'gemini-public'
  const datedKey = 'gemini-provider-20260904'
  const identity: TelemetryModelIdentity = {
    model: alias,
    upstream: 'upstream',
    modelKey: 'gemini-provider',
    cost: { input: 1, output: 1 },
    translatorPair: { source: 'gemini', hub: 'responses' },
  }
  const responseResult = {
    id: 'resp_hub', object: 'response', model: datedKey, output: [], status: 'completed',
    error: null, incomplete_details: null,
    usage: { input_tokens: 7, output_tokens: 3 },
  }
  async function* hubFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
    yield { type: 'event', event: { type: 'response.created', response: responseResult } }
    yield { type: 'event', event: { type: 'response.completed', response: responseResult } }
  }
  const result = llmEventResult(
    hubFrames(),
    identity,
    { keyId: 'gemini-responses-key', model: alias, modelKey: 'gemini-provider', upstream: 'upstream', stream: false, runtimeLocation: 'bun' },
    undefined,
    async () => ({ candidates: [] }),
    undefined,
    (modelKey) => modelKey === datedKey
      ? { ...identity, modelKey, cost: { input: 2, output: 4 } }
      : identity,
  )
  const response = await respondGemini(result, {
    wantsStream: false,
    telemetryCtx: {
      apiKeyId: 'gemini-responses-key' as never, userAgent: null, requestId: 'gemini-responses-request',
      isStreaming: false, runtimeLocation: 'bun', requestStartedAt: Date.now(), sourceApi: 'gemini',
    },
  })
  expect(await response.json()).toEqual({ candidates: [] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const usage = await repo.usage.query({
    keyId: 'gemini-responses-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(usage[0]).toMatchObject({
    model: alias, modelKey: datedKey, cost: { input: 2, output: 4 }, tokens: { input: 7, output: 3 },
  })
  const performance = await repo.performance.query({
    keyId: 'gemini-responses-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(performance.summary[0]).toMatchObject({ model: alias, sourceApi: 'gemini', targetApi: 'responses' })
})

test('Gemini nonstream Responses failure persists one failed performance row without usage', async () => {
  const { repo } = setupTestPlatform()
  const identity: TelemetryModelIdentity = {
    model: 'gemini-public', upstream: 'upstream', modelKey: 'provider-model', cost: null,
    translatorPair: { source: 'gemini', hub: 'responses' },
  }
  async function* hubFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
    yield {
      type: 'event',
      event: {
        type: 'response.failed',
        response: {
          id: 'resp_failed', object: 'response', model: 'provider-model', output: [], status: 'failed',
          error: { code: 'server_error', message: 'upstream unavailable' }, incomplete_details: null,
        },
      },
    }
  }
  const response = await respondGemini(
    llmEventResult(
      hubFrames(), identity,
      { keyId: 'gemini-responses-failed-key', model: identity.model, modelKey: identity.modelKey, upstream: 'upstream', stream: false, runtimeLocation: 'bun' },
      undefined, async () => ({ candidates: [] }),
    ),
    {
      wantsStream: false,
      telemetryCtx: {
        apiKeyId: 'gemini-responses-failed-key' as never, userAgent: null, requestId: 'gemini-responses-failed-request',
        isStreaming: false, runtimeLocation: 'bun', requestStartedAt: Date.now(), sourceApi: 'gemini',
      },
    },
  )
  expect(await response.json()).toEqual({ candidates: [] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await repo.usage.query({
    keyId: 'gemini-responses-failed-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })).toEqual([])
  const performance = await repo.performance.query({
    keyId: 'gemini-responses-failed-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(performance.summary).toHaveLength(1)
  expect(performance.summary[0]).toMatchObject({
    model: 'gemini-public', sourceApi: 'gemini', targetApi: 'responses', errors: 1,
  })
})

test('Gemini nonstream Messages error persists one failed performance row without usage', async () => {
  const { repo } = setupTestPlatform()
  const identity: TelemetryModelIdentity = {
    model: 'gemini-public', upstream: 'upstream', modelKey: 'provider-model', cost: null,
    translatorPair: { source: 'gemini', hub: 'messages' },
  }
  async function* hubFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
    yield {
      type: 'event',
      event: { type: 'error', error: { type: 'api_error', message: 'upstream unavailable' } },
    }
  }
  const response = await respondGemini(
    llmEventResult(
      hubFrames(), identity,
      { keyId: 'gemini-messages-failed-key', model: identity.model, modelKey: identity.modelKey, upstream: 'upstream', stream: false, runtimeLocation: 'bun' },
      undefined, async () => ({ candidates: [] }),
    ),
    {
      wantsStream: false,
      telemetryCtx: {
        apiKeyId: 'gemini-messages-failed-key' as never, userAgent: null, requestId: 'gemini-messages-failed-request',
        isStreaming: false, runtimeLocation: 'bun', requestStartedAt: Date.now(), sourceApi: 'gemini',
      },
    },
  )
  expect(response.status).toBe(502)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await repo.usage.query({
    keyId: 'gemini-messages-failed-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })).toEqual([])
  const performance = await repo.performance.query({
    keyId: 'gemini-messages-failed-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(performance.summary).toHaveLength(1)
  expect(performance.summary[0]).toMatchObject({
    model: 'gemini-public', sourceApi: 'gemini', targetApi: 'messages', errors: 1,
  })
})

test('Gemini nonstream messages hub persists message usage and provider key', async () => {
  const { repo } = setupTestPlatform()
  const alias = 'gemini-public'
  const providerKey = 'claude-provider-revision'
  const identity: TelemetryModelIdentity = {
    model: alias,
    upstream: 'upstream',
    modelKey: providerKey,
    cost: { input: 2, output: 4 },
    translatorPair: { source: 'gemini', hub: 'messages' },
  }
  async function* hubFrames(): AsyncGenerator<ProtocolFrame<unknown>> {
    yield {
      type: 'event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_hub', type: 'message', role: 'assistant', model: providerKey, content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
    }
    yield {
      type: 'event',
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    }
    yield { type: 'event', event: { type: 'message_stop' } }
  }
  const result = llmEventResult(
    hubFrames(),
    identity,
    { keyId: 'gemini-messages-key', model: alias, modelKey: providerKey, upstream: 'upstream', stream: false, runtimeLocation: 'bun' },
    undefined,
    async () => ({ candidates: [] }),
  )
  const response = await respondGemini(result, {
    wantsStream: false,
    telemetryCtx: {
      apiKeyId: 'gemini-messages-key' as never, userAgent: null, requestId: 'gemini-messages-request',
      isStreaming: false, runtimeLocation: 'bun', requestStartedAt: Date.now(), sourceApi: 'gemini',
    },
  })
  expect(await response.json()).toEqual({ candidates: [] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const usage = await repo.usage.query({
    keyId: 'gemini-messages-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(usage[0]).toMatchObject({
    model: alias, modelKey: providerKey, cost: { input: 2, output: 4 }, tokens: { input: 5, output: 2 },
  })
})

test('wantsStream=false + translateBody set with hub=messages: dispatches to messages reassembler', async () => {
  // Emit a minimal messages hub stream: message_start → content_block_start →
  // content_block_delta → content_block_stop → message_delta → message_stop
  const framesMessages: Array<ProtocolFrame<MessagesStreamEvent>> = [
    {
      type: 'event',
      event: {
        type: 'message_start',
        message: {
          id: 'm1', type: 'message', role: 'assistant', model: 'claude-3', content: [],
          stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      } as ProtocolFrame<MessagesStreamEvent>['event'],
    },
    {
      type: 'event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as ProtocolFrame<MessagesStreamEvent>['event'],
    },
    {
      type: 'event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } as ProtocolFrame<MessagesStreamEvent>['event'],
    },
    {
      type: 'event',
      event: { type: 'content_block_stop', index: 0 } as ProtocolFrame<MessagesStreamEvent>['event'],
    },
    {
      type: 'event',
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } } as ProtocolFrame<MessagesStreamEvent>['event'],
    },
    {
      type: 'event',
      event: { type: 'message_stop' } as ProtocolFrame<MessagesStreamEvent>['event'],
    },
  ]

  async function* messagesHubFrames(): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
    for (const f of framesMessages) yield f
  }

  const sentinelGeminiJson2 = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hi' }] } }] }
  const translateBody2 = mock(async (_hubJson: unknown) => sentinelGeminiJson2)

  const identity2: TelemetryModelIdentity = {
    ...stubIdentity,
    translatorPair: { source: 'gemini', hub: 'messages' },
  }

  const result2 = llmEventResult(
    messagesHubFrames() as unknown as AsyncIterable<unknown>,
    identity2,
    undefined,
    undefined,
    translateBody2 as never,
  )

  const resp2 = await respondGemini(result2, { wantsStream: false })
  expect(resp2.status).toBe(200)
  const json2 = await resp2.json()

  expect(translateBody2).toHaveBeenCalledTimes(1)
  // The first arg must be the messages-shaped JSON (has a 'content' array)
  const hubArg2 = translateBody2.mock.calls[0]![0] as { content?: unknown[]; type?: string }
  expect(hubArg2).toHaveProperty('content')
  expect(hubArg2.type).toBe('message')

  expect(json2).toEqual(sentinelGeminiJson2)
})
