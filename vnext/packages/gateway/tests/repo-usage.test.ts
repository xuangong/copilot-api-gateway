import { test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import type { Repo, UsageRecord } from '../src/repo/types.ts'

let db: Database
let repo: Repo

beforeEach(() => {
  db = new Database(':memory:')
  repo = new SqliteRepo(db)
})

const baseRec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  keyId: 'k1', incomingModel: 'gpt-4o', model: 'gpt-4o', modelKey: 'gpt-4o', upstream: 'copilot:1',
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

test('aliases routed to one model remain independent token and request buckets', async () => {
  await repo.usage.record(baseRec({ incomingModel: 'alias-a', tokens: { input: 100 }, requests: 2 }))
  await repo.usage.record(baseRec({ incomingModel: 'alias-b', tokens: { input: 200 }, requests: 3 }))

  const got = await repo.usage.listAll()
  expect(got).toEqual(expect.arrayContaining([
    expect.objectContaining({ incomingModel: 'alias-a', tokens: { input: 100 }, requests: 2 }),
    expect.objectContaining({ incomingModel: 'alias-b', tokens: { input: 200 }, requests: 3 }),
  ]))
})

test('set() replaces only the matching incoming-model bucket', async () => {
  await repo.usage.record(baseRec({ incomingModel: 'alias-a', tokens: { input: 100, output: 50 }, requests: 2 }))
  await repo.usage.record(baseRec({ incomingModel: 'alias-b', tokens: { input: 200 }, requests: 3 }))
  await repo.usage.set(baseRec({ incomingModel: 'alias-a', tokens: { input: 400 }, requests: 5 }))

  const got = await repo.usage.listAll()
  expect(got).toEqual(expect.arrayContaining([
    expect.objectContaining({ incomingModel: 'alias-a', tokens: { input: 400 }, requests: 5 }),
    expect.objectContaining({ incomingModel: 'alias-b', tokens: { input: 200 }, requests: 3 }),
  ]))
})

test('legacy unknown token-only, request-only, and full buckets assemble independently', async () => {
  db.exec(`
    INSERT INTO usage (key_id, incoming_model, model, upstream, model_key, client, hour, dimension, tokens, unit_price)
    VALUES ('k-token', '', 'target', NULL, 'provider', 'curl', '2026-06-13T10', 'input', 10, 1);
    INSERT INTO usage_requests (key_id, incoming_model, model, upstream, model_key, client, hour, requests)
    VALUES ('k-request', '', 'target', NULL, 'provider', 'curl', '2026-06-13T10', 2),
           ('k-full', '', 'target', NULL, 'provider', 'curl', '2026-06-13T10', 3);
    INSERT INTO usage (key_id, incoming_model, model, upstream, model_key, client, hour, dimension, tokens, unit_price)
    VALUES ('k-full', '', 'target', NULL, 'provider', 'curl', '2026-06-13T10', 'output', 30, 2);
  `)

  expect(await repo.usage.listAll()).toEqual(expect.arrayContaining([
    expect.objectContaining({ keyId: 'k-token', incomingModel: '', tokens: { input: 10 }, requests: 0 }),
    expect.objectContaining({ keyId: 'k-request', incomingModel: '', tokens: {}, requests: 2 }),
    expect.objectContaining({ keyId: 'k-full', incomingModel: '', tokens: { output: 30 }, requests: 3 }),
  ]))
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
