import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteRepo } from '../src/shared/repo/sqlite.ts'

const newRepo = () => new SqliteRepo(new Database(':memory:'))

test('SqliteRepo: apiKeys save + lookup round-trip', async () => {
  const repo = newRepo()
  const now = new Date().toISOString()
  await repo.apiKeys.save({
    id: 'k1', name: 'test', key: 'raw-secret-1', createdAt: now, ownerId: 'u1',
  })
  const byId = await repo.apiKeys.getById('k1')
  expect(byId?.name).toBe('test')
  const byKey = await repo.apiKeys.findByRawKey('raw-secret-1')
  expect(byKey?.id).toBe('k1')
  const list = await repo.apiKeys.listByOwner('u1')
  expect(list.length).toBe(1)
  expect(await repo.apiKeys.delete('k1')).toBe(true)
  expect(await repo.apiKeys.getById('k1')).toBeNull()
})

test('SqliteRepo: upstreams save + list round-trip', async () => {
  const repo = newRepo()
  const now = new Date().toISOString()
  await repo.upstreams.save({
    id: 'ups-1',
    provider: 'copilot',
    name: 'ups-1',
    ownerId: 'u1',
    enabled: true,
    sortOrder: 0,
    config: {},
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: now,
    updatedAt: now,
  })
  const found = await repo.upstreams.getById('ups-1')
  expect(found?.name).toBe('ups-1')
  const all = await repo.upstreams.list({ ownerId: 'u1' })
  expect(all.length).toBe(1)
})
