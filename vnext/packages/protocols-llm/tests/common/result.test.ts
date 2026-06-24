import { test, expect } from 'bun:test'
import {
  llmEventResult,
  llmInternalErrorResult,
  readUpstreamError,
  type TelemetryModelIdentity,
  type PerformanceTelemetryContext,
  type EventResultMetadata,
} from '@vnext-llm/protocols/common'

const identity = (): TelemetryModelIdentity => ({
  model: 'gpt-4',
  upstream: 'openai-prod',
  modelKey: 'gpt-4',
  cost: null,
})
const perf = (): PerformanceTelemetryContext => ({
  keyId: 'k1',
  model: 'gpt-4',
  upstream: 'openai-prod',
  modelKey: 'gpt-4',
  stream: true,
  runtimeLocation: 'bun',
})

async function* empty(): AsyncGenerator<number> { /* yields nothing */ }

test('llmEventResult requires modelIdentity, accepts performance + finalMetadata', () => {
  const r = llmEventResult(empty(), identity(), perf(), Promise.resolve({ modelIdentity: identity() }))
  expect(r.type).toBe('events')
  expect(r.modelIdentity.model).toBe('gpt-4')
  expect(r.performance?.keyId).toBe('k1')
  expect(r.finalMetadata).toBeInstanceOf(Promise)
})

test('llmEventResult without performance/finalMetadata leaves them undefined', () => {
  const r = llmEventResult(empty(), identity())
  expect(r.performance).toBeUndefined()
  expect(r.finalMetadata).toBeUndefined()
})

test('llmInternalErrorResult accepts optional performance', () => {
  const r = llmInternalErrorResult(502, new Error('boom'), perf())
  expect(r.performance?.keyId).toBe('k1')
  const r2 = llmInternalErrorResult(404, new Error('nope'))
  expect(r2.performance).toBeUndefined()
})

test('readUpstreamError accepts optional performance', async () => {
  const resp = new Response('body', { status: 401 })
  const r = await readUpstreamError(resp, perf())
  expect(r.status).toBe(401)
  expect(r.performance?.keyId).toBe('k1')
})

test('EventResultMetadata shape', () => {
  const md: EventResultMetadata = { modelIdentity: identity(), performance: perf() }
  expect(md.modelIdentity.upstream).toBe('openai-prod')
})

test('llmEventResult accepts translateBody', () => {
  async function* gen() { yield 1 as never }
  const id = { model: 'm', upstream: 'u', modelKey: 'k', cost: null }
  const tb = (j: unknown) => ({ ok: true, j })
  const r = llmEventResult(gen(), id, undefined, undefined, tb)
  expect(r.translateBody).toBe(tb)
})

test('llmInternalErrorResult accepts reason', () => {
  const r = llmInternalErrorResult(400, new Error('bad'), undefined, 'translator-validation')
  expect(r.reason).toBe('translator-validation')
})

test('TelemetryModelIdentity accepts translatorPair', () => {
  const id: TelemetryModelIdentity = {
    model: 'm', upstream: 'u', modelKey: 'k', cost: null,
    translatorPair: { source: 'chat_completions' as const, hub: 'responses' as const },
  }
  expect(id.translatorPair?.hub).toBe('responses')
})
