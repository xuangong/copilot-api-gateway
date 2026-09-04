import { test, expect, beforeEach } from 'bun:test'
import { setupTestPlatform } from '../../../_setup-platform.ts'
import {
  SourceStreamState,
  eventResultMetadata,
  finalModelIdentity,
  normalizeStreamEventModel,
  performanceTargetFromTranslatorPair,
  recordUsage,
  recordPerformance,
} from '../../../../src/data-plane/chat-flow/shared/respond-telemetry.ts'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx.ts'
import type {
  LlmEventResult,
  TelemetryModelIdentity,
  PerformanceTelemetryContext,
} from '@vibe-llm/protocols/common'
import type { Repo } from '../../../../src/repo/types.ts'

const identity = (modelKey = 'gpt-4'): TelemetryModelIdentity => ({
  incomingModel: 'team-gpt',
  model: 'gpt-4',
  upstream: 'openai-prod',
  modelKey,
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

const ctx: TelemetryRequestContext = {
  incomingModel: 'gpt-4',
  apiKeyId: 'k1',
  userAgent: null,
  requestId: 'r1',
  isStreaming: true,
  runtimeLocation: 'bun',
  requestStartedAt: Date.now(),
}

beforeEach(() => setupTestPlatform())

test('eventResultMetadata retains request incoming model when finalMetadata corrects provider identity', async () => {
  const replaced: LlmEventResult<unknown> = {
    type: 'events',
    events: (async function* () {})(),
    modelIdentity: identity('gpt-4'),
    finalMetadata: Promise.resolve({ modelIdentity: identity('gpt-4-turbo') }),
    // Provenance flag suppresses the drift warn for legitimate replacement.
    __interceptorReplaced: true,
  } as LlmEventResult<unknown> & { __interceptorReplaced: true }
  const md = await eventResultMetadata(replaced, ctx)
  expect(md.modelIdentity.incomingModel).toBe('gpt-4')
  expect(md.modelIdentity.modelKey).toBe('gpt-4-turbo')
})

test('eventResultMetadata falls back to result.modelIdentity + performance', async () => {
  const r: LlmEventResult<unknown> = {
    type: 'events',
    events: (async function* () {})(),
    modelIdentity: identity('gpt-4'),
    performance: perf(),
  }
  const md = await eventResultMetadata(r)
  expect(md.modelIdentity.modelKey).toBe('gpt-4')
  expect(md.performance?.keyId).toBe('k1')
})

test('finalModelIdentity preserves a more specific mapped destination and its price', () => {
  const fast = { ...identity('gpt-5.6-sol-fast'), cost: { input: 2 } as never }
  const final = finalModelIdentity(fast, 'gpt-5.6-sol', (key) =>
    ({ ...fast, modelKey: key, cost: { input: 1 } as never }),
  )
  expect(final).toBe(fast)
})

test('finalModelIdentity accepts a dated correction and reprices it', () => {
  const initial = { ...identity('gpt-4-turbo'), cost: { input: 1 } as never }
  const dated = { ...initial, modelKey: 'gpt-4-turbo-2025', cost: { input: 3 } as never }
  expect(finalModelIdentity(initial, 'gpt-4-turbo-2025', (key) =>
    key === dated.modelKey ? dated : null,
  )).toBe(dated)
})

test('finalModelIdentity retains initial identity when resolver is missing', () => {
  const initial = { ...identity('gpt-4'), cost: { input: 1 } as never }
  expect(finalModelIdentity(initial, '', () => null)).toBe(initial)
  expect(finalModelIdentity(initial, 'unrelated')).toBe(initial)
})

test('finalModelIdentity accepts an unpriced provider revision while retaining public model', () => {
  const initial = {
    ...identity('gpt-4-turbo'),
    model: 'gpt-4-turbo',
    cost: { input: 1 } as never,
  }
  const resolved = finalModelIdentity(initial, 'gpt-4-turbo-2025', (modelKey) => ({
    ...initial, modelKey, cost: null,
  }))
  expect(resolved.modelKey).toBe('gpt-4-turbo-2025')
  expect(resolved.incomingModel).toBe('team-gpt')
  expect(resolved.model).toBe('gpt-4-turbo')
  expect(resolved.cost).toBeNull()
})

test('normalizeStreamEventModel clones only observed model-bearing paths', () => {
  const event = { model: 'gpt-5.6-sol', response: { model: 'gpt-5.6-sol' }, message: { model: 'gpt-5.6-sol' } }
  const normalized = normalizeStreamEventModel(event, 'gpt-5.6-sol-fast') as typeof event
  expect(normalized).not.toBe(event)
  expect(normalized.model).toBe('gpt-5.6-sol-fast')
  expect(normalized.response).not.toBe(event.response)
  expect(normalized.response.model).toBe('gpt-5.6-sol-fast')
  expect(normalized.message.model).toBe('gpt-5.6-sol-fast')
  expect(normalizeStreamEventModel({ usage: {} }, 'gpt-5.6-sol-fast')).toEqual({ usage: {} })
})

test('normalizeStreamEventModel normalizes every model field, while unchanged event retains identity', () => {
  const event = {
    model: 'base',
    modelVersion: 'base-version',
    response: { model: 'nested-response', stable: true },
    message: { model: 'nested-message', stable: true },
  }
  const normalized = normalizeStreamEventModel(event, 'destination') as typeof event
  expect(normalized.model).toBe('destination')
  expect(normalized.modelVersion).toBe('destination')
  expect(normalized.response.model).toBe('destination')
  expect(normalized.message.model).toBe('destination')
  expect(event.model).toBe('base')
  const already = { model: 'destination', response: { model: 'destination' } }
  expect(normalizeStreamEventModel(already, 'destination')).toBe(already)
})

test('SourceStreamState accumulates usage via rememberUsage', () => {
  const s = new SourceStreamState('gpt-4')
  s.rememberUsage({
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  })
  expect(s.usage.tokens.input).toBe(1)
  expect(s.usage.tokens.output).toBe(2)
})

test('SourceStreamState.failedAfter flips failed flag', () => {
  const s = new SourceStreamState('gpt-4')
  expect(s.failed).toBe(false)
  s.failedAfter()
  expect(s.failed).toBe(true)
})

test('recordUsage writes one row + touchLastUsed when usage non-zero', async () => {
  const usageRows: unknown[] = []
  const touched: string[] = []
  const stub = {
    usage: { record: async (row: unknown) => { usageRows.push(row) } },
    apiKeys: { touchLastUsed: async (id: string) => { touched.push(id) } },
  } as unknown as Repo

  await recordUsage(ctx, identity('gpt-4'), { input: 5, output: 7 }, stub)
  expect(usageRows.length).toBe(1)
  expect(touched).toEqual(['k1'])
  const row = usageRows[0] as Record<string, unknown>
  expect(row.keyId).toBe('k1')
  expect(row.incomingModel).toBe('team-gpt')
  expect(row.modelKey).toBe('gpt-4')
  expect(row.upstream).toBe('openai-prod')
  expect(row.requests).toBe(1)
})

test('recordUsage no-ops when token counts are all zero/undefined', async () => {
  const usageRows: unknown[] = []
  const touched: string[] = []
  const stub = {
    usage: { record: async (row: unknown) => { usageRows.push(row) } },
    apiKeys: { touchLastUsed: async (id: string) => { touched.push(id) } },
  } as unknown as Repo

  await recordUsage(ctx, identity('gpt-4'), {}, stub)
  await recordUsage(ctx, identity('gpt-4'), { input: 0, output: 0 }, stub)
  expect(usageRows.length).toBe(0)
  expect(touched.length).toBe(0)
})

test('recordPerformance no-ops when performance undefined', async () => {
  const calls: unknown[] = []
  const stub = {
    performance: { record: async (row: unknown) => { calls.push(row) } },
  } as unknown as Repo
  await recordPerformance(ctx, undefined, false, stub)
  expect(calls.length).toBe(0)
})

test('recordPerformance writes one row carrying isError flag + durationMs', async () => {
  const calls: Record<string, unknown>[] = []
  const stub = {
    performance: { record: async (row: Record<string, unknown>) => { calls.push(row) } },
  } as unknown as Repo
  const startedAt = Date.now() - 10
  const myCtx: TelemetryRequestContext = { ...ctx, requestStartedAt: startedAt }
  await recordPerformance(myCtx, perf(), true, stub)
  expect(calls).toHaveLength(1)
  const row = calls[0]!
  // Spec §6.2 surfaces a `failed` flag; legacy PerformanceRecordInput uses
  // `isError`. Helper translates `failed` → `isError` to match the repo
  // contract.
  expect(row.isError).toBe(true)
  expect(typeof row.durationMs).toBe('number')
  expect((row.durationMs as number) >= 10).toBe(true)
  expect(row.keyId).toBe('k1')
  expect(row.upstream).toBe('openai-prod')
  expect(row.runtimeLocation).toBe('bun')
  // Required PerformanceRecordInput fields
  expect(typeof row.hour).toBe('string')
  expect(row.metricScope).toBe('request_total')
  expect(row.model).toBe('gpt-4')
  expect(row.stream).toBe(true)
})

test('recordPerformance defaults sourceApi to chat-completions when ctx omits it', async () => {
  const calls: Record<string, unknown>[] = []
  const stub = {
    performance: { record: async (row: Record<string, unknown>) => { calls.push(row) } },
  } as unknown as Repo
  await recordPerformance(ctx, perf(), false, stub)
  expect(calls[0]?.sourceApi).toBe('chat-completions')
  expect(calls[0]?.targetApi).toBe('chat-completions')
})

test('recordPerformance threads sourceApi from ctx and mirrors targetApi for same-protocol', async () => {
  const calls: Record<string, unknown>[] = []
  const stub = {
    performance: { record: async (row: Record<string, unknown>) => { calls.push(row) } },
  } as unknown as Repo
  await recordPerformance({ ...ctx, sourceApi: 'messages' }, perf(), false, stub)
  expect(calls[0]?.sourceApi).toBe('messages')
  expect(calls[0]?.targetApi).toBe('messages')
})

test('recordPerformance routes gemini source through chat-completions target', async () => {
  const calls: Record<string, unknown>[] = []
  const stub = {
    performance: { record: async (row: Record<string, unknown>) => { calls.push(row) } },
  } as unknown as Repo
  await recordPerformance({ ...ctx, sourceApi: 'gemini' }, perf(), false, stub)
  expect(calls[0]?.sourceApi).toBe('gemini')
  expect(calls[0]?.targetApi).toBe('chat-completions')
})

test('performanceTargetFromTranslatorPair maps protocol spelling for persisted targets', () => {
  expect(performanceTargetFromTranslatorPair({ ...identity(), translatorPair: { source: 'messages', hub: 'chat_completions' } })).toBe('chat-completions')
  expect(performanceTargetFromTranslatorPair({ ...identity(), translatorPair: { source: 'messages', hub: 'responses' } })).toBe('responses')
  expect(performanceTargetFromTranslatorPair({ ...identity(), translatorPair: { source: 'messages', hub: 'gemini' } })).toBeUndefined()
})

test('recordPerformance honors hubOverride when translator carries a hub', async () => {
  const calls: Record<string, unknown>[] = []
  const stub = {
    performance: { record: async (row: Record<string, unknown>) => { calls.push(row) } },
  } as unknown as Repo
  await recordPerformance({ ...ctx, sourceApi: 'responses' }, perf(), false, stub, 'chat-completions')
  expect(calls[0]?.sourceApi).toBe('responses')
  expect(calls[0]?.targetApi).toBe('chat-completions')
})
