import { test, expect } from 'bun:test'
import {
  llmEventResult,
  eventProducerProtocol,
  type TranslatedLlmEventResult,
  llmInternalErrorResult,
  readUpstreamError,
  type TelemetryModelIdentity,
  type PerformanceTelemetryContext,
  type EventResultMetadata,
} from '@vibe-llm/protocols/common'

const identity = (): TelemetryModelIdentity => ({
  incomingModel: 'gpt-4',
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

test('translated event results require a producer domain and independent adapters', () => {
  const r: TranslatedLlmEventResult = {
    type: 'events',
    producer: { kind: 'translated', source: 'responses', protocol: 'chat_completions' },
    events: (async function* () {})(),
    modelIdentity: identity(),
    translateBody: value => value,
    translateEvents: values => values,
  }
  expect(eventProducerProtocol(r, 'responses')).toBe('chat_completions')
  expect(() => eventProducerProtocol(r, 'messages')).toThrow('Invalid translated')
})

test('llmInternalErrorResult accepts reason', () => {
  const r = llmInternalErrorResult(400, new Error('bad'), undefined, 'translator-validation')
  expect(r.reason).toBe('translator-validation')
})

test('TelemetryModelIdentity accepts translatorPair', () => {
  const id: TelemetryModelIdentity = {
    incomingModel: 'incoming-m', model: 'm', upstream: 'u', modelKey: 'k', cost: null,
    translatorPair: { source: 'chat_completions' as const, hub: 'responses' as const },
  }
  expect(id.translatorPair?.hub).toBe('responses')
})
