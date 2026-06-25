import { test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import type { Repo, UsageRecord } from '../src/shared/repo/types.ts'

let db: Database
let repo: Repo

beforeEach(() => {
  db = new Database(':memory:')
  repo = new SqliteRepo(db)
})

const baseRec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  keyId: 'k1', model: 'gpt-4o', modelKey: 'gpt-4o', upstream: 'copilot:1',
  client: 'curl', hour: '2026-06-13T10', requests: 1,
  tokens: { input: 100, output: 50 }, cost: { input: 2.5, output: 10 },
  ...over,
})

test('record() is additive: two calls double tokens, double requests, keep first unit_price', async () => {
  await repo.usage.record(baseRec())
  await repo.usage.record(baseRec({ cost: { input: 9999, output: 9999 } })) // new price ignored per COALESCE rule

  const got = await repo.usage.listAll()
  expect(got).toHaveLength(1)
  expect(got[0].requests).toBe(2)
  expect(got[0].tokens).toEqual({ input: 200, output: 100 })
  expect(got[0].cost).toEqual({ input: 2.5, output: 10 }) // first non-null wins
})

test('set() is replacement: drops dimensions absent from the new record', async () => {
  await repo.usage.record(baseRec({ tokens: { input: 100, output: 50, input_cache_read: 10 } }))
  await repo.usage.set(baseRec({ tokens: { input: 200 }, requests: 5 }))

  const got = await repo.usage.listAll()
  expect(got).toHaveLength(1)
  expect(got[0].tokens).toEqual({ input: 200 })
  expect(got[0].requests).toBe(5)
})

test('record() with cost=null persists null unit_price; query reassembles cost=null', async () => {
  await repo.usage.record(baseRec({ cost: null }))
  const got = await repo.usage.listAll()
  expect(got[0].cost).toBeNull()
})

test('query() honors hour range', async () => {
  await repo.usage.record(baseRec({ hour: '2026-06-13T09' }))
  await repo.usage.record(baseRec({ hour: '2026-06-13T10' }))
  await repo.usage.record(baseRec({ hour: '2026-06-13T11' }))
  const got = await repo.usage.query({ keyId: 'k1', start: '2026-06-13T10', end: '2026-06-13T11' })
  expect(got).toHaveLength(1)
  expect(got[0].hour).toBe('2026-06-13T10')
})
