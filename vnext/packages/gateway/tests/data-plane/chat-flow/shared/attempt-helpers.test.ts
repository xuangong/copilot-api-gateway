import { test, expect } from 'bun:test'
import {
  telemetryModelIdentity,
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

test('telemetryModelIdentity uses bareModel as initial modelKey + resolves cost', () => {
  const id = telemetryModelIdentity(fakeBinding as never, 'gpt-4')
  expect(id.model).toBe('gpt-4')
  expect(id.upstream).toBe('openai-prod')
  expect(id.modelKey).toBe('gpt-4')
  expect(id.cost).toEqual({ inputPerM: 1, outputPerM: 2 })
})

test('telemetryModelIdentity tolerates unknown modelKey (cost null)', () => {
  const id = telemetryModelIdentity(fakeBinding as never, 'gpt-unknown')
  expect(id.cost).toBeNull()
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
