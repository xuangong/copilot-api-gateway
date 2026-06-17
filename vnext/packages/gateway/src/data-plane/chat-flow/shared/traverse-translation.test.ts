import { test, expect } from 'bun:test'
import { traverseTranslation } from './traverse-translation.ts'
import { TranslatorValidationError } from '@vnext/translate/errors'
import { eventResult, internalErrorResult } from '@vnext/protocols/common'
import type { PairTranslator } from '../../dispatch/translator-registry.ts'

const fakeTelemetryCtx = {} as never

const fakeIdentity = { model: 'm', upstream: 'u', modelKey: 'k', cost: null }

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
  const innerResult = eventResult(hubEvents(), fakeIdentity)
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

test('upstream-error pass-through unchanged', async () => {
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
  expect(result).toBe(upstream)
})

test('internal-error reason is prefixed with via-translator', async () => {
  const inner = internalErrorResult(500, new Error('inner'), undefined, 'inner-cause')
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

test('translateEvents mid-stream error becomes terminal source-error frame, does not throw', async () => {
  async function* hubEvents() {
    yield { kind: 'hub-evt' } as never
    throw new Error('mid-stream failure')
  }
  const innerResult = eventResult(hubEvents(), fakeIdentity)
  const result = await traverseTranslation({
    sourcePayload: { model: 'x' },
    sourceProtocol: 'chat_completions',
    hubProtocol: 'responses',
    translator: fakeTranslator({
      translateEvents: async function* (events) {
        for await (const e of events) yield e as never
      },
    }),
    innerAttempt: async () => innerResult,
    inheritedHeaders: {},
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(result.type).toBe('events')
  if (result.type !== 'events') throw new Error('unreachable')
  // Iterator must complete without throwing — wrapper swallows + emits terminal error frame.
  const collected: unknown[] = []
  for await (const f of result.events) collected.push(f)
  expect(collected.length).toBeGreaterThan(0)
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
      return eventResult(hubEvents(), fakeIdentity)
    },
    inheritedHeaders: { 'x-trace-id': 'abc' },
    inheritedTelemetryCtx: fakeTelemetryCtx,
    auth: {} as never,
  })
  expect(captured).toEqual({ 'x-trace-id': 'abc' })
})
