import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteRepo } from '../../src/shared/repo/sqlite.ts'
import type { ApiKey } from '../../src/shared/repo/types.ts'

function freshRepo(): SqliteRepo {
  const db = new Database(':memory:')
  return new SqliteRepo(db)
}

function fakeKey(id: string): ApiKey {
  return {
    id,
    name: id,
    key: `sk-${id}`,
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    lastUsedAt: undefined,
    ownerId: 'owner-1',
    quotaRequestsPerDay: null,
    quotaTokensPerDay: null,
    webSearchEnabled: false,
    webSearchLangsearchKey: null,
    webSearchTavilyKey: null,
    webSearchMsGroundingKey: null,
    webSearchPriority: null,
    webSearchLangsearchRef: null,
    webSearchTavilyRef: null,
    webSearchMsGroundingRef: null,
  } as ApiKey
}

test('touchLastUsed bumps lastUsedAt to now', async () => {
  const repo = freshRepo()
  await repo.apiKeys.save(fakeKey('k1'))
  const before = await repo.apiKeys.getById('k1')
  expect(before?.lastUsedAt).toBeFalsy()

  await repo.apiKeys.touchLastUsed('k1')

  const after = await repo.apiKeys.getById('k1')
  expect(after?.lastUsedAt).toBeTruthy()
  expect(new Date(after!.lastUsedAt!).toString()).not.toBe('Invalid Date')
})

test('touchLastUsed on unknown id is a no-op (does not throw)', async () => {
  const repo = freshRepo()
  await repo.apiKeys.touchLastUsed('does-not-exist')
  expect(true).toBe(true)
})
