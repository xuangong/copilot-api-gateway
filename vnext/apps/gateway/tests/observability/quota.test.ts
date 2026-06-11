import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteRepo } from '../../src/shared/repo/sqlite.ts'
import { setRepoOverride, clearRepoOverride } from '../../src/shared/repo/index.ts'
import { checkQuota, computeWeightedTokens } from '../../src/shared/observability/quota.ts'

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  setRepoOverride(repo)
})
afterEach(() => clearRepoOverride())

const baseKey = (over: Partial<{ quotaRequestsPerDay: number | null; quotaTokensPerDay: number | null }> = {}) => ({
  id: 'k1',
  name: 'k1',
  key: 'sk-k1',
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: undefined,
  ownerId: 'o1',
  quotaRequestsPerDay: null,
  quotaTokensPerDay: null,
  webSearchEnabled: false,
  webSearchLangsearchKey: null, webSearchTavilyKey: null, webSearchMsGroundingKey: null,
  webSearchPriority: null,
  webSearchLangsearchRef: null, webSearchTavilyRef: null, webSearchMsGroundingRef: null,
  ...over,
} as any)

test('checkQuota: re-exports formula', () => {
  expect(computeWeightedTokens(100, 0, 0)).toBeCloseTo(10)
})

test('checkQuota: unknown key id allowed', async () => {
  const r = await checkQuota('no-such-key')
  expect(r.allowed).toBe(true)
})

test('checkQuota: key with no quotas configured allowed', async () => {
  await repo.apiKeys.save(baseKey())
  const r = await checkQuota('k1')
  expect(r.allowed).toBe(true)
})

test('checkQuota: request quota exceeded denies with Retry-After', async () => {
  await repo.apiKeys.save(baseKey({ quotaRequestsPerDay: 2 }))
  const today = new Date().toISOString().slice(0, 10) + 'T00'
  await repo.usage.record('k1', 'gpt-4o', today, 2, 100, 50)
  const r = await checkQuota('k1')
  expect(r.allowed).toBe(false)
  expect(r.reason).toMatch(/request quota/i)
  expect(r.retryAfterSeconds).toBeGreaterThan(0)
  expect(r.retryAfterSeconds).toBeLessThanOrEqual(86400)
})

test('checkQuota: token quota exceeded denies', async () => {
  await repo.apiKeys.save(baseKey({ quotaTokensPerDay: 500 }))
  const today = new Date().toISOString().slice(0, 10) + 'T00'
  await repo.usage.record('k1', 'gpt-4o', today, 1, 100, 100)
  const r = await checkQuota('k1')
  expect(r.allowed).toBe(false)
  expect(r.reason).toMatch(/token quota/i)
})

test('checkQuota: usage below quota allowed', async () => {
  await repo.apiKeys.save(baseKey({ quotaRequestsPerDay: 100, quotaTokensPerDay: 1_000_000 }))
  const today = new Date().toISOString().slice(0, 10) + 'T00'
  await repo.usage.record('k1', 'gpt-4o', today, 1, 10, 10)
  const r = await checkQuota('k1')
  expect(r.allowed).toBe(true)
})
