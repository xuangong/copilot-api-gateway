import { test, expect } from 'bun:test'
import {
  initialProviderModelKey,
  telemetryModelIdentity,
  modelIdentityResolver,
  providerResponseToExecuteResult,
  upstreamPerformanceContext,
} from '../../../../src/data-plane/chat-flow/shared/attempt-helpers.ts'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx.ts'

const fakeBinding = {
  upstream: 'openai-prod',
  model: { id: 'gpt-4' },
  provider: {
    getPricingForModelKey: (k: string) => k === 'gpt-4' ? { inputPerM: 1, outputPerM: 2 } : null,
  },
} as const

const ctx = (over: Partial<TelemetryRequestContext> = {}): TelemetryRequestContext => ({
  apiKeyId: 'k1', userAgent: null, requestId: 'r1',
  isStreaming: true, runtimeLocation: 'bun', requestStartedAt: 0,
  ...over,
})

test('telemetryModelIdentity preserves incoming alias and public target while pricing provider revision', () => {
  const id = telemetryModelIdentity(fakeBinding as never, 'gpt-4', {
    incomingModel: 'team-gpt',
    publicModel: 'gpt-4',
  })
  expect(id.incomingModel).toBe('team-gpt')
  expect(id.model).toBe('gpt-4')
  expect(id.upstream).toBe('openai-prod')
  expect(id.modelKey).toBe('gpt-4')
  expect(id.cost).toEqual({ inputPerM: 1, outputPerM: 2 })
})

test('telemetryModelIdentity keeps an explicit routed destination distinct from binding id', () => {
  const id = telemetryModelIdentity(
    fakeBinding as never,
    'gpt-5.6-sol-fast',
    { incomingModel: 'gpt-5.6-sol-fast', publicModel: 'gpt-5.6-sol-fast' },
  )
  expect(id.model).toBe('gpt-5.6-sol-fast')
})

test('provider revisions retain the routed public model while using the provider key for pricing', () => {
  const datedKey = 'claude-sonnet-4-5-20250929'
  const datedPricing = { inputPerM: 3, outputPerM: 15 }
  const claudeBinding = {
    upstream: 'claude-code',
    model: {
      id: 'claude-sonnet-4-5',
      providerModelKey: datedKey,
    },
    provider: {
      getPricingForModelKey: (key: string) => key === datedKey
        ? datedPricing
        : null,
    },
  }
  const publicModel = claudeBinding.model.id
  const input = { incomingModel: 'team-sonnet', publicModel }
  const initialKey = initialProviderModelKey(claudeBinding, publicModel)
  const initial = telemetryModelIdentity(claudeBinding, initialKey, input)
  const performance = upstreamPerformanceContext(ctx(), claudeBinding, initialKey, publicModel)
  const corrected = modelIdentityResolver(claudeBinding, input)(datedKey)

  expect(initial).toEqual({
    incomingModel: 'team-sonnet',
    model: publicModel,
    upstream: 'claude-code',
    modelKey: datedKey,
    cost: datedPricing,
  })
  expect(performance.model).toBe(publicModel)
  expect(performance.modelKey).toBe(datedKey)
  expect(corrected).toEqual(initial)
})

test('providerResponseToExecuteResult separates public aliases from provider keys', () => {
  const datedKey = 'claude-sonnet-4-5-20250929'
  const binding = {
    upstream: 'claude-code',
    model: { id: 'claude-sonnet-4-5', providerModelKey: datedKey },
    provider: { getPricingForModelKey: (key: string) => key === datedKey ? { inputPerM: 3 } : null },
  }
  const result = providerResponseToExecuteResult({
    providerResp: {
      status: 200,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    },
    binding,
    telemetryCtx: ctx(),
    bareModel: 'claude-sonnet-4-5',
    incomingModel: 'team-sonnet',
    protocol: 'messages',
    toEvents: async function* () {},
  })

  expect(result.modelIdentity).toEqual({
    incomingModel: 'team-sonnet',
    model: 'claude-sonnet-4-5',
    upstream: 'claude-code',
    modelKey: datedKey,
    cost: { inputPerM: 3 },
  })
  expect(result.performance).toMatchObject({
    model: 'claude-sonnet-4-5',
    modelKey: datedKey,
  })
})

test('modelIdentityResolver corrects only provider key and cost for an unpriced revision', () => {
  const input = { incomingModel: 'team-gpt', publicModel: 'gpt-4' }
  const corrected = modelIdentityResolver(fakeBinding as never, input)('gpt-unknown')
  expect(corrected).toEqual({
    incomingModel: 'team-gpt',
    model: 'gpt-4',
    upstream: 'openai-prod',
    modelKey: 'gpt-unknown',
    cost: null,
  })
})

test('upstreamPerformanceContext mirrors telemetryCtx + binding', () => {
  const perf = upstreamPerformanceContext(ctx(), fakeBinding as never, 'gpt-4')
  expect(perf.keyId).toBe('k1')
  expect(perf.model).toBe('gpt-4')
  expect(perf.upstream).toBe('openai-prod')
  expect(perf.modelKey).toBe('gpt-4')
  expect(perf.stream).toBe(true)
  expect(perf.runtimeLocation).toBe('bun')
})
