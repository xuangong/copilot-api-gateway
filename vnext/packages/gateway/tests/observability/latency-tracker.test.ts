import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vnext-llm/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo } from '../../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vnext-gateway/platform'
import { recordLatency, startTimer } from '../../src/shared/observability/latency-tracker.ts'

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  initRepo(repo)
})
afterEach(() => __resetPlatformForTests())

const today = () => new Date().toISOString().slice(0, 13)

test('startTimer returns a function returning elapsed ms', async () => {
  const elapsed = startTimer()
  await new Promise(r => setTimeout(r, 5))
  expect(elapsed()).toBeGreaterThanOrEqual(4)
})

test('recordLatency without source/target is a no-op (legacy latency table no longer written)', async () => {
  await recordLatency('k1', 'gpt-4o', 'docker', { totalMs: 100, upstreamMs: 80, ttfbMs: 80, tokenMiss: false })
  const lat = await repo.latency.query({ keyId: 'k1', start: today().slice(0,10)+'T00', end: today().slice(0,10)+'T24' })
  expect(lat.length).toBe(0)
  const perf = await repo.performance.query({ keyId: 'k1', start: today().slice(0,10)+'T00', end: today().slice(0,10)+'T24' })
  expect(perf.summary.length).toBe(0)
  expect(perf.buckets.length).toBe(0)
})

test('recordLatency with source+target fans out to both perf scopes on success', async () => {
  await recordLatency('k1', 'claude-opus-4.7', 'docker',
    { totalMs: 200, upstreamMs: 150, ttfbMs: 150, tokenMiss: false },
    'req-1',
    { stream: true, sourceApi: 'messages', targetApi: 'messages', upstream: 'copilot:1' },
  )
  const perf = await repo.performance.query({ keyId: 'k1', start: today().slice(0,10)+'T00', end: today().slice(0,10)+'T24' })
  expect(perf.summary.length).toBe(2)
  const total = perf.summary.find(r => r.metricScope === 'request_total')!
  const success = perf.summary.find(r => r.metricScope === 'upstream_success')!
  expect(total.totalMsSum).toBe(200)
  expect(success.totalMsSum).toBe(150)
  expect(success.errors).toBe(0)
})

test('recordLatency with isError fans out request_total only (no upstream_success)', async () => {
  await recordLatency('k1', 'gpt-4o', 'docker',
    { totalMs: 50, upstreamMs: 40, ttfbMs: 40, tokenMiss: false },
    'req-2',
    { stream: false, sourceApi: 'chat_completions', targetApi: 'chat_completions', isError: true, upstream: 'copilot:1' },
  )
  const perf = await repo.performance.query({ keyId: 'k1', start: today().slice(0,10)+'T00', end: today().slice(0,10)+'T24' })
  expect(perf.summary.length).toBe(1)
  expect(perf.summary[0].metricScope).toBe('request_total')
  expect(perf.summary[0].errors).toBe(1)
})

test('recordLatency translates chat_completions → chat-completions for perf enums', async () => {
  await recordLatency('k1', 'gpt-4o', 'docker',
    { totalMs: 10, upstreamMs: 8, ttfbMs: 8, tokenMiss: false },
    undefined,
    { stream: false, sourceApi: 'chat_completions', targetApi: 'chat_completions', upstream: 'copilot:1' },
  )
  const perf = await repo.performance.query({ keyId: 'k1', start: today().slice(0,10)+'T00', end: today().slice(0,10)+'T24' })
  expect(perf.summary[0].sourceApi).toBe('chat-completions')
  expect(perf.summary[0].targetApi).toBe('chat-completions')
})

test('recordLatency with images target writes latency only (no perf row)', async () => {
  await recordLatency('k1', 'dall-e-3', 'docker',
    { totalMs: 1000, upstreamMs: 900, ttfbMs: 900, tokenMiss: false },
    undefined,
    { stream: false, sourceApi: 'chat_completions', upstream: 'copilot:1' },
  )
  const perf = await repo.performance.query({ keyId: 'k1', start: today().slice(0,10)+'T00', end: today().slice(0,10)+'T24' })
  expect(perf.summary.length).toBe(0)
})
