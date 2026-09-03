import { test, expect, beforeEach } from 'bun:test'
import { initRepo } from '../src/repo/index.ts'
import { __resetPlatformForTests } from '@vibe-core/platform'
import type { ApiKey, Repo } from '../src/repo/types.ts'
import { DEFAULT_API_KEY_MODEL_MAPPINGS } from '../src/shared/api-key-model-mappings.ts'
import {
  createApiKey,
  listApiKeys,
  listApiKeysByOwner,
  getApiKeyById,
  renameApiKey,
  rotateApiKey,
  deleteApiKey,
  validateApiKey,
  touchApiKeyLastUsed,
} from '../src/control-plane/lib/api-keys.ts'

function inMemoryApiKeyRepo() {
  const store = new Map<string, ApiKey>()
  return {
    store,
    repo: {
      list: async () => [...store.values()],
      listByOwner: async (owner: string) => [...store.values()].filter((k) => k.ownerId === owner),
      findByRawKey: async (raw: string) => [...store.values()].find((k) => k.key === raw) ?? null,
      getById: async (id: string) => store.get(id) ?? null,
      save: async (k: ApiKey) => { store.set(k.id, k) },
      delete: async (id: string) => store.delete(id),
      deleteAll: async () => { store.clear() },
    },
  }
}

let store: Map<string, ApiKey>

beforeEach(() => {
  const { store: s, repo: apiKeys } = inMemoryApiKeyRepo()
  store = s
  initRepo({ apiKeys } as unknown as Repo)
})

test('createApiKey sets defaults and persists', async () => {
  const k = await createApiKey('test-key', 'user-1')
  expect(k.name).toBe('test-key')
  expect(k.ownerId).toBe('user-1')
  expect(k.webSearchEnabled).toBe(true)
  expect(k.modelMappingsEnabled).toBe(false)
  expect(k.modelMappings).toEqual(DEFAULT_API_KEY_MODEL_MAPPINGS)
  expect(k.key).toMatch(/^[0-9a-f]{64}$/)
  expect(store.get(k.id)).toEqual(k)
})

test('createApiKey gives each key independent default mapping objects', async () => {
  const first = await createApiKey('first')
  const second = await createApiKey('second')

  expect(first.modelMappings).not.toBe(second.modelMappings)
  expect(first.modelMappings[0]).not.toBe(second.modelMappings[0])
  expect(first.modelMappings).not.toBe(DEFAULT_API_KEY_MODEL_MAPPINGS)
})

test('list / listByOwner / getById round-trip', async () => {
  const a = await createApiKey('a', 'u1')
  const b = await createApiKey('b', 'u2')
  expect((await listApiKeys()).map((k) => k.id).sort()).toEqual([a.id, b.id].sort())
  expect((await listApiKeysByOwner('u1')).map((k) => k.id)).toEqual([a.id])
  expect((await getApiKeyById(a.id))?.name).toBe('a')
  expect(await getApiKeyById('missing')).toBeNull()
})

test('renameApiKey updates name, returns null when missing', async () => {
  const a = await createApiKey('a')
  const renamed = await renameApiKey(a.id, 'new-name')
  expect(renamed?.name).toBe('new-name')
  expect((await getApiKeyById(a.id))?.name).toBe('new-name')
  expect(await renameApiKey('missing', 'x')).toBeNull()
})

test('rotateApiKey changes raw key, preserves id', async () => {
  const a = await createApiKey('a')
  const rotated = await rotateApiKey(a.id)
  expect(rotated?.id).toBe(a.id)
  expect(rotated?.key).not.toBe(a.key)
  expect(rotated?.key).toMatch(/^[0-9a-f]{64}$/)
})

test('deleteApiKey returns boolean', async () => {
  const a = await createApiKey('a')
  expect(await deleteApiKey(a.id)).toBe(true)
  expect(await deleteApiKey('missing')).toBe(false)
})

test('validateApiKey returns only its minimal routing projection', async () => {
  const a = await createApiKey('a', 'owner-x')
  const v = await validateApiKey(a.key)

  expect(v).toEqual({
    id: a.id,
    name: 'a',
    ownerId: 'owner-x',
    routingPolicy: { modelMappingsEnabled: false, modelMappings: DEFAULT_API_KEY_MODEL_MAPPINGS },
  })
  expect(v).not.toHaveProperty('key')
  expect(v).not.toHaveProperty('webSearchEnabled')
  expect(v).not.toHaveProperty('webSearchProvider')
  expect(v).not.toHaveProperty('quota')
  expect(v).not.toHaveProperty('createdAt')
  expect(await validateApiKey('bogus')).toBeNull()
})

test('validateApiKey fail-closes invalid stored mappings and clones its routing policy', async () => {
  const a = await createApiKey('a')
  const stored = store.get(a.id)
  if (!stored) throw new Error('test key missing')
  stored.modelMappingsEnabled = true
  stored.modelMappings = [{ source: 'source', destination: 'destination' }]
  stored.modelMappingsInvalid = true

  const v = await validateApiKey(a.key)
  expect(v?.routingPolicy).toEqual({ modelMappingsEnabled: false, modelMappings: [] })

  stored.modelMappingsInvalid = false
  const valid = await validateApiKey(a.key)
  expect(valid?.routingPolicy.modelMappings).not.toBe(stored.modelMappings)
  expect(valid?.routingPolicy.modelMappings[0]).not.toBe(stored.modelMappings[0])
})

test('touchApiKeyLastUsed stamps lastUsedAt, no-op when missing', async () => {
  const a = await createApiKey('a')
  expect(a.lastUsedAt).toBeUndefined()
  await touchApiKeyLastUsed(a.id)
  expect((await getApiKeyById(a.id))?.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  // no throw on missing
  await touchApiKeyLastUsed('missing')
})
