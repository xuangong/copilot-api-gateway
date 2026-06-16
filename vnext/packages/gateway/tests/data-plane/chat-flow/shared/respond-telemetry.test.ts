import { test, expect, beforeEach } from 'bun:test'
import { setupTestPlatform } from '../../../_setup-platform.ts'
import {
  SourceStreamState,
  eventResultMetadata,
  recordUsage,
  recordPerformance,
} from '../../../../src/data-plane/chat-flow/shared/respond-telemetry.ts'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx.ts'
import type {
  EventResult,
  TelemetryModelIdentity,
  PerformanceTelemetryContext,
} from '@vnext/protocols/common'
import type { Repo } from '../../../../src/shared/repo/types.ts'

const identity = (modelKey = 'gpt-4'): TelemetryModelIdentity => ({
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
  apiKeyId: 'k1',
  userAgent: null,
  requestId: 'r1',
  isStreaming: true,
  runtimeLocation: 'bun',
  requestStartedAt: Date.now(),
}

beforeEach(() => setupTestPlatform())

test('eventResultMetadata prefers finalMetadata when present', async () => {
  const replaced: EventResult<unknown> = {
    type: 'events',
    events: (async function* () {})(),
    modelIdentity: identity('gpt-4'),
    finalMetadata: Promise.resolve({ modelIdentity: identity('gpt-4-turbo') }),
    // Provenance flag suppresses the drift warn for legitimate replacement.
    __interceptorReplaced: true,
  } as EventResult<unknown> & { __interceptorReplaced: true }
  const md = await eventResultMetadata(replaced)
  expect(md.modelIdentity.modelKey).toBe('gpt-4-turbo')
})

test('eventResultMetadata falls back to result.modelIdentity + performance', async () => {
  const r: EventResult<unknown> = {
    type: 'events',
    events: (async function* () {})(),
    modelIdentity: identity('gpt-4'),
    performance: perf(),
  }
  const md = await eventResultMetadata(r)
  expect(md.modelIdentity.modelKey).toBe('gpt-4')
  expect(md.performance?.keyId).toBe('k1')
})

test('SourceStreamState.rememberModelKey accepts only non-empty differing values', () => {
  const s = new SourceStreamState('gpt-4')
  expect(s.modelKey).toBe('gpt-4')
  s.rememberModelKey('')
  expect(s.modelKey).toBe('gpt-4')
  s.rememberModelKey('gpt-4')
  expect(s.modelKey).toBe('gpt-4')
  s.rememberModelKey('gpt-4-turbo-2025')
  expect(s.modelKey).toBe('gpt-4-turbo-2025')
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
