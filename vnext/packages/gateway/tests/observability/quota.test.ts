import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo } from '../../src/repo/index.ts'
import { __resetPlatformForTests } from '@vibe-core/platform'
import { checkQuota, computeWeightedTokens } from '../../src/data-plane/observability/quota.ts'

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  initRepo(repo)
})
afterEach(() => __resetPlatformForTests())

const baseKey = (over: Partial<{ quotaRequestsPerMonth: number | null; quotaTokensPerMonth: number | null }> = {}) => ({
  id: 'k1',
  name: 'k1',
  key: 'sk-k1',
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: undefined,
  ownerId: 'o1',
  quotaRequestsPerMonth: null,
  quotaTokensPerMonth: null,
  webSearchEnabled: false,
  webSearchLangsearchKey: null, webSearchTavilyKey: null, webSearchMsGroundingKey: null,
  webSearchPriority: null,
  webSearchLangsearchRef: null, webSearchTavilyRef: null, webSearchMsGroundingRef: null,
  ...over,
} as any)

const thisMonthHour = () => new Date().toISOString().slice(0, 10) + 'T00'

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
  await repo.apiKeys.save(baseKey({ quotaRequestsPerMonth: 2 }))
  await repo.usage.record({
    keyId: 'k1', model: 'gpt-4o', modelKey: 'gpt-4o', upstream: null, client: '',
    hour: thisMonthHour(), requests: 2, tokens: { input: 100, output: 50 }, cost: null,
  })
  const r = await checkQuota('k1')
  expect(r.allowed).toBe(false)
  expect(r.reason).toMatch(/request quota/i)
  expect(r.retryAfterSeconds).toBeGreaterThan(0)
  expect(r.retryAfterSeconds).toBeLessThanOrEqual(31 * 86400)
})

test('checkQuota: token quota exceeded denies', async () => {
  await repo.apiKeys.save(baseKey({ quotaTokensPerMonth: 500 }))
  await repo.usage.record({
    keyId: 'k1', model: 'gpt-4o', modelKey: 'gpt-4o', upstream: null, client: '',
    hour: thisMonthHour(), requests: 1, tokens: { input: 100, output: 100 }, cost: null,
  })
  const r = await checkQuota('k1')
  expect(r.allowed).toBe(false)
  expect(r.reason).toMatch(/token quota/i)
})

test('checkQuota: usage below quota allowed', async () => {
  await repo.apiKeys.save(baseKey({ quotaRequestsPerMonth: 100, quotaTokensPerMonth: 1_000_000 }))
  await repo.usage.record({
    keyId: 'k1', model: 'gpt-4o', modelKey: 'gpt-4o', upstream: null, client: '',
    hour: thisMonthHour(), requests: 1, tokens: { input: 10, output: 10 }, cost: null,
  })
  const r = await checkQuota('k1')
  expect(r.allowed).toBe(true)
})

test('checkQuota: last month usage does not count against this month', async () => {
  await repo.apiKeys.save(baseKey({ quotaRequestsPerMonth: 2 }))
  const now = new Date()
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))
  await repo.usage.record({
    keyId: 'k1', model: 'gpt-4o', modelKey: 'gpt-4o', upstream: null, client: '',
    hour: lastMonth.toISOString().slice(0, 10) + 'T00', requests: 99,
    tokens: { input: 100, output: 50 }, cost: null,
  })
  const r = await checkQuota('k1')
  expect(r.allowed).toBe(true)
})
