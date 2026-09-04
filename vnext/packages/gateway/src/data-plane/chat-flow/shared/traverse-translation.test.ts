import { test, expect } from 'bun:test'
import { traverseTranslation } from './traverse-translation.ts'
import { TranslatorValidationError } from '@vibe-llm/translate/errors'
import { llmEventResult, llmInternalErrorResult } from '@vibe-llm/protocols/common'
import { eventResultMetadata, finalModelIdentity, performanceTargetFromTranslatorPair } from './respond-telemetry.ts'
import { respondResponses } from '../responses/respond.ts'
import { setupTestPlatform } from '../../../../tests/_setup-platform.ts'
import type { PairTranslator } from '../../dispatch/translator-registry.ts'

const fakeTelemetryCtx = { incomingModel: 'outer-alias' } as never

const fakeIdentity = { incomingModel: 'outer-alias', model: 'm', upstream: 'u', modelKey: 'k', cost: null }

function fakeTranslator(overrides: Partial<PairTranslator> = {}): PairTranslator {
  return {
    translateRequest: async (p) => p,
    translateEvents: async function* (events) { for await (const e of events) yield e as never },
    translateBody: (j) => j,
    ...overrides,
  } as PairTranslator
}

test('happy path: stamps translatorPair and forwards translateBody', async () => {
  async function* hubEvents() { yield { kind: 'hub-evt' } as never }
  const innerResult = llmEventResult(hubEvents(), fakeIdentity)
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator(),
    innerAttempt: async () => innerResult,
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('events')
  if (result.type !== 'events') throw new Error('unreachable')
  expect(result.modelIdentity.translatorPair).toEqual({
    source: 'chat_completions',
    hub: 'responses',
  })
  expect(result.translateBody).toBeDefined()
})

test('translated authoritative metadata, resolver, and performance target retain one translator pair', async () => {
  async function* hubEvents() { yield { kind: 'hub-evt' } as never }
  const authoritative = { incomingModel: 'inner-alias', model: 'corrected', upstream: 'u', modelKey: 'corrected', cost: null }
  const performance = {
    keyId: 'key', model: 'corrected', upstream: 'u', modelKey: 'corrected',
    stream: true, runtimeLocation: 'bun' as const,
  }
  const innerResult = llmEventResult(
    hubEvents(),
    fakeIdentity,
    undefined,
    Promise.resolve({ modelIdentity: authoritative, performance }),
    undefined,
    undefined,
    (modelKey) => ({ ...fakeIdentity, modelKey }),
  )
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' }, sourceProtocol: 'messages', hubProtocol: 'responses',
    translator: fakeTranslator(), innerAttempt: async () => innerResult,
    inheritedHeaders: {}, inheritedTelemetryCtx: fakeTelemetryCtx, auth: {} as never,
  })
  if (result.type !== 'events') throw new Error('unreachable')
  const pair = { source: 'messages' as const, hub: 'responses' as const }
  expect(result.modelIdentity.translatorPair).toEqual(pair)
  expect(result.modelIdentity.incomingModel).toBe('outer-alias')
  expect(result.resolveModelIdentity?.('corrected')).toEqual({
    ...fakeIdentity, incomingModel: 'outer-alias', modelKey: 'corrected', translatorPair: pair,
  })
  const metadata = await result.finalMetadata
  expect(metadata).toEqual({
    modelIdentity: { ...authoritative, incomingModel: 'outer-alias', translatorPair: pair },
    performance,
  })
  expect(metadata?.modelIdentity.incomingModel).toBe('outer-alias')
  expect(metadata?.performance).toBe(performance)
  const persisted = await eventResultMetadata(result)
  expect(persisted.modelIdentity.translatorPair).toEqual(pair)
  expect(finalModelIdentity(result.modelIdentity, 'other', result.resolveModelIdentity)).toEqual({
    ...fakeIdentity, incomingModel: 'outer-alias', modelKey: 'other', translatorPair: pair,
  })
  expect(performanceTargetFromTranslatorPair(persisted.modelIdentity)).toBe('responses')
})

test('translated responder persists the authoritative final metadata hub target', async () => {
  const { repo } = setupTestPlatform()
  async function* hubEvents() {
    const response = {
      id: 'resp_1', object: 'response', model: 'corrected', output: [],
      status: 'completed', error: null, incomplete_details: null,
    }
    yield { type: 'event' as const, event: { type: 'response.completed', response } }
  }
  const authoritative = { incomingModel: 'inner-alias', model: 'corrected', upstream: 'u', modelKey: 'corrected', cost: null }
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' }, sourceProtocol: 'messages', hubProtocol: 'responses',
    translator: fakeTranslator(),
    innerAttempt: async () => ({
      ...llmEventResult(
        hubEvents(),
        fakeIdentity,
        undefined,
        Promise.resolve({ modelIdentity: authoritative, performance: {
          keyId: 'translated-key', model: 'corrected', upstream: 'u', modelKey: 'corrected',
          stream: false, runtimeLocation: 'bun',
        } }),
      ),
      __interceptorReplaced: true as const,
    }),
    inheritedHeaders: {}, inheritedTelemetryCtx: fakeTelemetryCtx, auth: {} as never,
  })
  const response = await respondResponses(result as never, {
    wantsStream: false,
    telemetryCtx: {
      incomingModel: 'translated-source',
      apiKeyId: 'translated-key' as never, userAgent: null, requestId: 'translated-request',
      isStreaming: false, runtimeLocation: 'bun', requestStartedAt: Date.now(), sourceApi: 'messages',
    },
  })
  await response.text()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const persisted = await repo.performance.query({
    keyId: 'translated-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(persisted.summary).toHaveLength(1)
  expect(persisted.summary[0]?.sourceApi).toBe('messages')
  expect(persisted.summary[0]?.targetApi).toBe('responses')
})

test('translated finalMetadata preserves rejection from the inner attempt', async () => {
  async function* hubEvents() { yield { kind: 'hub-evt' } as never }
  const failure = new Error('metadata failure')
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' }, sourceProtocol: 'messages', hubProtocol: 'responses',
    translator: fakeTranslator(),
    innerAttempt: async () => llmEventResult(hubEvents(), fakeIdentity, undefined, Promise.reject(failure)),
    inheritedHeaders: {}, inheritedTelemetryCtx: fakeTelemetryCtx, auth: {} as never,
  })
  if (result.type !== 'events') throw new Error('unreachable')
  await expect(result.finalMetadata).rejects.toBe(failure)
})

test('translated upstream errors preserve body and status while recording the hub target', async () => {
  const { repo } = setupTestPlatform()
  const body = new TextEncoder().encode('{"error":{"message":"slow down"}}')
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' }, sourceProtocol: 'messages', hubProtocol: 'responses',
    translator: fakeTranslator(),
    innerAttempt: async () => ({
      type: 'upstream-error' as const, status: 429, headers: new Headers({ 'retry-after': '1' }), body,
      performance: {
        keyId: 'translated-error-key', model: 'x', modelKey: 'x', upstream: 'u',
        stream: false, runtimeLocation: 'bun' as const,
      },
    }),
    inheritedHeaders: {}, inheritedTelemetryCtx: fakeTelemetryCtx, auth: {} as never,
  })
  expect(result.type).toBe('upstream-error')
  if (result.type !== 'upstream-error') throw new Error('expected upstream error')
  expect(result.status).toBe(429)
  expect(result.body).toBe(body)
  expect(result.targetApi).toBe('responses')
  const response = await respondResponses(result as never, {
    wantsStream: false,
    telemetryCtx: {
      incomingModel: 'translated-source',
      apiKeyId: 'translated-error-key' as never, userAgent: null, requestId: 'translated-error',
      isStreaming: false, runtimeLocation: 'bun', requestStartedAt: Date.now(), sourceApi: 'messages',
    },
  })
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('1')
  expect(await response.text()).toBe('{"error":{"message":"slow down"}}')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const persisted = await repo.performance.query({
    keyId: 'translated-error-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(persisted.summary[0]?.sourceApi).toBe('messages')
  expect(persisted.summary[0]?.targetApi).toBe('responses')
})

test('gemini translated upstream errors persist the responses hub instead of its default target', async () => {
  const { repo } = setupTestPlatform()
  const result = await traverseTranslation({
    sourcePayload: {}, sourceProtocol: 'gemini', hubProtocol: 'responses', translator: fakeTranslator(),
    innerAttempt: async () => ({
      type: 'upstream-error' as const, status: 503, headers: new Headers(), body: new Uint8Array(),
      performance: {
        keyId: 'gemini-translated-error', model: 'public-model', modelKey: 'provider-key', upstream: 'u',
        stream: false, runtimeLocation: 'bun' as const,
      },
    }),
    inheritedHeaders: {}, inheritedTelemetryCtx: fakeTelemetryCtx, auth: {} as never,
  })
  const response = await respondResponses(result as never, {
    wantsStream: false,
    telemetryCtx: {
      incomingModel: 'translated-source',
      apiKeyId: 'gemini-translated-error' as never, userAgent: null, requestId: 'gemini-translated-error',
      isStreaming: false, runtimeLocation: 'bun', requestStartedAt: Date.now(), sourceApi: 'gemini',
    },
  })
  expect(response.status).toBe(503)
  await response.text()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const persisted = await repo.performance.query({
    keyId: 'gemini-translated-error' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(persisted.summary[0]).toMatchObject({ sourceApi: 'gemini', targetApi: 'responses' })
})

test('translated upstream errors retain actual hub targets across source protocols', async () => {
  const cases = [
    { sourceProtocol: 'responses' as const, hubProtocol: 'messages' as const, targetApi: 'messages' as const },
    { sourceProtocol: 'gemini' as const, hubProtocol: 'responses' as const, targetApi: 'responses' as const },
    { sourceProtocol: 'chat_completions' as const, hubProtocol: 'responses' as const, targetApi: 'responses' as const },
  ]
  for (const item of cases) {
    const upstream = {
      type: 'upstream-error' as const,
      status: 500,
      headers: new Headers(),
      body: new Uint8Array(),
    }
    const result = await traverseTranslation({
      sourcePayload: {},
      sourceProtocol: item.sourceProtocol,
      hubProtocol: item.hubProtocol,
      translator: fakeTranslator(),
      innerAttempt: async () => upstream,
      inheritedHeaders: {},
      inheritedTelemetryCtx: fakeTelemetryCtx,
      auth: {} as never,
    })
    expect(result.type).toBe('upstream-error')
    if (result.type !== 'upstream-error') throw new Error('expected upstream error')
    expect(result.targetApi).toBe(item.targetApi)
    expect(result.body).toBe(upstream.body)
    expect(result.headers).toBe(upstream.headers)
  }
})

test('nested translations keep the deepest upstream error target', async () => {
  const upstream = {
    type: 'upstream-error' as const, status: 500, headers: new Headers(), body: new Uint8Array(), targetApi: 'responses' as const,
  }
  const result = await traverseTranslation({
    sourcePayload: {}, sourceProtocol: 'chat_completions', hubProtocol: 'messages', translator: fakeTranslator(),
    innerAttempt: async () => upstream, inheritedHeaders: {}, inheritedTelemetryCtx: fakeTelemetryCtx, auth: {} as never,
  })
  expect(result).toBe(upstream)
})

test('TranslatorValidationError → 400 with reason translator-validation', async () => {
  const result = await traverseTranslation({
    sourcePayload: {},
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator({
      translateRequest: async () => { throw new TranslatorValidationError('missing model') },
    }),
    innerAttempt: async () => { throw new Error('should not be called') },
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('internal-error')
  if (result.type !== 'internal-error') throw new Error('unreachable')
  expect(result.status).toBe(400)
  expect(result.reason).toBe('translator-validation')
})

test('generic translator throw → 500 with reason translator-internal', async () => {
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator({
      translateRequest: async () => { throw new Error('boom') },
    }),
    innerAttempt: async () => { throw new Error('should not be called') },
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('internal-error')
  if (result.type !== 'internal-error') throw new Error('unreachable')
  expect(result.status).toBe(500)
  expect(result.reason).toBe('translator-internal')
})

test('upstream-error receives the translated target while preserving its response fields', async () => {
  const upstream = {
    type: 'upstream-error' as const,
    status: 502,
    headers: new Headers(),
    body: new Uint8Array(),
  }
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator(),
    innerAttempt: async () => upstream,
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('upstream-error')
  if (result.type !== 'upstream-error') throw new Error('expected upstream error')
  expect(result).toEqual({ ...upstream, targetApi: 'responses' })
  expect(result.body).toBe(upstream.body)
  expect(result.headers).toBe(upstream.headers)
})

test('internal-error reason is prefixed with via-translator', async () => {
  const inner = llmInternalErrorResult(500, new Error('inner'), undefined, 'inner-cause')
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator(),
    innerAttempt: async () => inner,
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('internal-error')
  if (result.type !== 'internal-error') throw new Error('unreachable')
  expect(result.reason).toBe('via-translator:chat_completions→responses:inner-cause')
})

test('hub events pass through unchanged (translator NOT applied in traverse)', async () => {
  // After spec §3.7, traverseTranslation is a pass-through for events:
  // it yields the inner attempt's hub-shape frames verbatim and exposes the
  // translator on the result via `translateEvents` / `translateBody` so
  // respond.ts can apply it lazily depending on streaming/non-streaming mode.
  // The translator must NOT be invoked here.
  let translatorCalled = false
  async function* hubEvents() {
    yield { kind: 'hub-evt-1' } as never
    yield { kind: 'hub-evt-2' } as never
  }
  const innerResult = llmEventResult(hubEvents(), fakeIdentity)
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator({
      translateEvents: async function* () {
        translatorCalled = true
        yield { kind: 'translated' } as never
      },
    }),
    innerAttempt: async () => innerResult,
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('events')
  if (result.type !== 'events') throw new Error('unreachable')
  // Drain the events — should yield hub frames untranslated.
  const collected: Array<{ kind?: string }> = []
  for await (const f of result.events) collected.push(f as { kind?: string })
  expect(translatorCalled).toBe(false)
  expect(collected).toEqual([{ kind: 'hub-evt-1' }, { kind: 'hub-evt-2' }])
  // The translator is exposed on the result so respond.ts can apply it.
  expect(result.translateEvents).toBeDefined()
  expect(result.translateBody).toBeDefined()
})

test('mid-stream error propagates verbatim (no swallowing in traverseTranslation)', async () => {
  // After spec §3.7, traverseTranslation no longer wraps the events with a
  // safe iterator — error handling is the source-protocol respond.ts layer's
  // responsibility (its SSE renderer has try/catch and emits a terminal
  // event:error frame). The pass-through traverseTranslation lets errors
  // propagate naturally.
  async function* hubEvents() {
    yield { kind: 'hub-evt' } as never
    throw new Error('mid-stream failure')
  }
  const innerResult = llmEventResult(hubEvents(), fakeIdentity)
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator(),
    innerAttempt: async () => innerResult,
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('events')
  if (result.type !== 'events') throw new Error('unreachable')
  const collected: unknown[] = []
  let caught: Error | null = null
  try {
    for await (const f of result.events) collected.push(f)
  } catch (err) {
    caught = err as Error
  }
  expect(collected.length).toBe(1)
  expect(caught?.message).toBe('mid-stream failure')
})

test('header inheritance: passes inheritedHeaders into innerAttempt', async () => {
  let captured: Record<string, string> | undefined
  async function* hubEvents() { yield { kind: 'hub-evt' } as never }
  await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator(),
    innerAttempt: async (innerArgs) => {
      captured = innerArgs.inheritedHeaders
      return llmEventResult(hubEvents(), fakeIdentity)
    },
    inheritedHeaders: { 'x-trace-id': 'abc' },
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(captured).toEqual({ 'x-trace-id': 'abc' })
})
