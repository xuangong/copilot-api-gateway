import { test, expect } from 'bun:test'
import { parseClaudeCodeQuotaHeaders, computeClaudeCodeQuotaTtlMs } from '../quota'

const buildHeaders = (init: Record<string, string>): Headers => new Headers(init)

test('parses full unified header surface', () => {
  const nowSec = 1_800_000_000
  const headers = buildHeaders({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-reset': String(nowSec + 3600),
    'anthropic-ratelimit-unified-fallback': 'available',
    'anthropic-ratelimit-unified-fallback-percentage': '0.25',
    'anthropic-ratelimit-unified-representative-claim': 'claim-abc',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-reset': String(nowSec + 1800),
    'anthropic-ratelimit-unified-5h-utilization': '0.42',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-reset': String(nowSec + 604800),
    'anthropic-ratelimit-unified-7d-utilization': '0.13',
    'anthropic-ratelimit-unified-7d-surpassed-threshold': 'false',
    'anthropic-ratelimit-unified-overage-status': 'inactive',
    'anthropic-ratelimit-unified-overage-reset': String(nowSec + 900),
    'anthropic-ratelimit-unified-overage-utilization': '0',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'not_enabled',
  })

  const snapshot = parseClaudeCodeQuotaHeaders(headers)

  expect(snapshot.status).toBe('allowed')
  expect(snapshot.reset).toBe(new Date((nowSec + 3600) * 1000).toISOString())
  expect(snapshot.fallbackAvailable).toBe(true)
  expect(snapshot.fallbackPercentage).toBe(0.25)
  expect(snapshot.representativeClaim).toBe('claim-abc')
  expect(snapshot.fiveHour).toEqual({
    status: 'allowed',
    reset: new Date((nowSec + 1800) * 1000).toISOString(),
    utilization: 0.42,
  })
  expect(snapshot.sevenDay).toEqual({
    status: 'allowed',
    reset: new Date((nowSec + 604800) * 1000).toISOString(),
    utilization: 0.13,
    surpassedThreshold: false,
  })
  expect(snapshot.overage).toEqual({
    status: 'inactive',
    reset: new Date((nowSec + 900) * 1000).toISOString(),
    utilization: 0,
    disabledReason: 'not_enabled',
  })
  expect(snapshot.raw['anthropic-ratelimit-unified-status']).toBe('allowed')
})

test('missing sub-blocks parse as null', () => {
  const snapshot = parseClaudeCodeQuotaHeaders(buildHeaders({}))
  expect(snapshot.status).toBeNull()
  expect(snapshot.reset).toBeNull()
  expect(snapshot.fallbackAvailable).toBeNull()
  expect(snapshot.fiveHour).toBeNull()
  expect(snapshot.sevenDay).toBeNull()
  expect(snapshot.overage).toBeNull()
  expect(Object.keys(snapshot.raw)).toHaveLength(0)
})

test('fallback header only "available" maps to true', () => {
  const snap = parseClaudeCodeQuotaHeaders(
    buildHeaders({ 'anthropic-ratelimit-unified-fallback': 'unavailable' }),
  )
  expect(snap.fallbackAvailable).toBe(false)
})

test('computeClaudeCodeQuotaTtlMs floors at 24h', () => {
  const now = new Date('2026-06-01T00:00:00Z')
  const snapshot = parseClaudeCodeQuotaHeaders(buildHeaders({}))
  expect(computeClaudeCodeQuotaTtlMs(snapshot, now)).toBe(24 * 60 * 60 * 1000)
})

test('computeClaudeCodeQuotaTtlMs uses furthest horizon', () => {
  const now = new Date('2026-06-01T00:00:00Z')
  const nowSec = Math.floor(now.getTime() / 1000)
  const snapshot = parseClaudeCodeQuotaHeaders(
    buildHeaders({
      'anthropic-ratelimit-unified-reset': String(nowSec + 3600),
      'anthropic-ratelimit-unified-7d-reset': String(nowSec + 3 * 24 * 3600),
    }),
  )
  expect(computeClaudeCodeQuotaTtlMs(snapshot, now)).toBe(3 * 24 * 3600 * 1000)
})
