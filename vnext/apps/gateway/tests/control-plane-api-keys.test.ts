/**
 * Control-plane api-keys router tests — Week 5a-impl.
 *
 * Covers the 11 endpoints ported from old src/routes/api-keys.ts. Uses an
 * in-memory Repo + a small pre-middleware to inject `c.set('auth', {...})`
 * since no auth middleware has been ported yet.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { setRepoForTest } from '../src/shared/repo/index.ts'
import type {
  ApiKey,
  KeyAssignment,
  Repo,
  User,
  WebSearchUsageRecord,
  WebSearchEngineUsageRecord,
} from '../src/shared/repo/types.ts'
import { apiKeysRouter, type AuthCtx } from '../src/control-plane/api-keys/routes.ts'
import { createApiKey } from '../src/shared/lib/api-keys.ts'

function inMemoryRepo() {
  const keys = new Map<string, ApiKey>()
  const users = new Map<string, User>()
  const assignments: KeyAssignment[] = []
  const wsUsage: WebSearchUsageRecord[] = []
  const wsEngineUsage: WebSearchEngineUsageRecord[] = []

  const repo = {
    apiKeys: {
      list: async () => [...keys.values()],
      listByOwner: async (owner: string) => [...keys.values()].filter((k) => k.ownerId === owner),
      findByRawKey: async (raw: string) => [...keys.values()].find((k) => k.key === raw) ?? null,
      getById: async (id: string) => keys.get(id) ?? null,
      save: async (k: ApiKey) => { keys.set(k.id, k) },
      delete: async (id: string) => keys.delete(id),
      deleteAll: async () => { keys.clear() },
    },
    users: {
      create: async (u: User) => { users.set(u.id, u) },
      getById: async (id: string) => users.get(id) ?? null,
      findByKey: async () => null,
      findByEmail: async (email: string) => [...users.values()].find((u) => u.email === email) ?? null,
      list: async () => [...users.values()],
      update: async () => { },
      delete: async (id: string) => { users.delete(id) },
    },
    keyAssignments: {
      assign: async (keyId: string, userId: string, assignedBy: string) => {
        assignments.push({ keyId, userId, assignedBy, assignedAt: new Date().toISOString() })
      },
      unassign: async (keyId: string, userId: string) => {
        for (let i = assignments.length - 1; i >= 0; i--) {
          if (assignments[i]!.keyId === keyId && assignments[i]!.userId === userId) assignments.splice(i, 1)
        }
      },
      listByUser: async (userId: string) => assignments.filter((a) => a.userId === userId),
      listByKey: async (keyId: string) => assignments.filter((a) => a.keyId === keyId),
      deleteByKey: async (keyId: string) => {
        for (let i = assignments.length - 1; i >= 0; i--) if (assignments[i]!.keyId === keyId) assignments.splice(i, 1)
      },
      deleteByUser: async () => { },
    },
    webSearchUsage: {
      record: async () => { },
      query: async () => wsUsage,
      deleteAll: async () => { },
    },
    webSearchEngineUsage: {
      record: async () => { },
      query: async () => wsEngineUsage,
      deleteAll: async () => { },
    },
  } as unknown as Repo

  return { repo, keys, users, assignments }
}

function buildApp(auth: AuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api/keys', apiKeysRouter)
  return app
}

let store: ReturnType<typeof inMemoryRepo>

beforeEach(() => {
  store = inMemoryRepo()
  setRepoForTest(store.repo)
})

test('GET / as admin returns all keys with assignees', async () => {
  await store.repo.users.create({ id: 'u1', name: 'Alice', createdAt: 'x', disabled: false })
  await store.repo.users.create({ id: 'u2', name: 'Bob', createdAt: 'x', disabled: false })
  const k = await createApiKey('a', 'u1')
  await store.repo.keyAssignments.assign(k.id, 'u2', 'admin')
  const app = buildApp({ isAdmin: true })
  const res = await app.request('/api/keys')
  expect(res.status).toBe(200)
  const body = await res.json() as any[]
  expect(body).toHaveLength(1)
  expect(body[0].owner_name).toBe('Alice')
  expect(body[0].assignees).toEqual([{ user_id: 'u2', user_name: 'Bob' }])
})

test('GET / as user returns own + assigned keys', async () => {
  await store.repo.users.create({ id: 'u1', name: 'Alice', createdAt: 'x', disabled: false })
  await store.repo.users.create({ id: 'u2', name: 'Bob', createdAt: 'x', disabled: false })
  const own = await createApiKey('mine', 'u1')
  const others = await createApiKey('shared', 'u2')
  await store.repo.keyAssignments.assign(others.id, 'u1', 'u2')
  const app = buildApp({ isUser: true, userId: 'u1' })
  const res = await app.request('/api/keys')
  const body = await res.json() as any[]
  expect(body).toHaveLength(2)
  const ownEntry = body.find((b) => b.id === own.id)
  const sharedEntry = body.find((b) => b.id === others.id)
  expect(ownEntry.is_owner).toBe(true)
  expect(sharedEntry.is_owner).toBe(false)
})

test('GET / unauthenticated returns []', async () => {
  await createApiKey('x', 'someone')
  const res = await buildApp({}).request('/api/keys')
  expect(await res.json()).toEqual([])
})

test('POST / creates key with name', async () => {
  const app = buildApp({ isUser: true, userId: 'u1' })
  const res = await app.request('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'new-key' }), headers: { 'content-type': 'application/json' } })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.name).toBe('new-key')
  expect(body.owner_id).toBe('u1')
})

test('POST / missing name → 400', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/keys', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
  expect(res.status).toBe(400)
})

test('PATCH XOR literal vs ref → 400', async () => {
  const k = await createApiKey('k1', 'u1')
  const res = await buildApp({ isAdmin: true }).request(`/api/keys/${k.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ web_search_langsearch_key: 'literal', web_search_langsearch_ref: 'ref-id' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
  const body = await res.json() as any
  expect(body.error).toMatch(/Cannot set both/)
})

test('PATCH rename and quota fields', async () => {
  const k = await createApiKey('original', 'u1')
  const res = await buildApp({ isAdmin: true }).request(`/api/keys/${k.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'renamed', quota_requests_per_day: 100 }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.name).toBe('renamed')
  expect(body.quota_requests_per_day).toBe(100)
})

test('PATCH non-owner → 403', async () => {
  const k = await createApiKey('k1', 'u1')
  const res = await buildApp({ isUser: true, userId: 'other' }).request(`/api/keys/${k.id}`, {
    method: 'PATCH', body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(403)
})

test('POST /:id/rotate changes raw key', async () => {
  const k = await createApiKey('k1', 'u1')
  const origRaw = k.key
  const res = await buildApp({ isAdmin: true }).request(`/api/keys/${k.id}/rotate`, { method: 'POST' })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.key).not.toBe(origRaw)
})

test('DELETE /:id removes key and assignments', async () => {
  await store.repo.users.create({ id: 'u2', name: 'Bob', createdAt: 'x', disabled: false })
  const k = await createApiKey('k', 'u1')
  await store.repo.keyAssignments.assign(k.id, 'u2', 'u1')
  const res = await buildApp({ isAdmin: true }).request(`/api/keys/${k.id}`, { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(store.keys.has(k.id)).toBe(false)
  expect(await store.repo.keyAssignments.listByKey(k.id)).toEqual([])
})

test('POST /:id/assign by email succeeds', async () => {
  await store.repo.users.create({ id: 'u2', name: 'Bob', email: 'bob@x.com', createdAt: 'x', disabled: false })
  const k = await createApiKey('k', 'u1')
  const res = await buildApp({ isUser: true, userId: 'u1' }).request(`/api/keys/${k.id}/assign`, {
    method: 'POST', body: JSON.stringify({ email: 'bob@x.com' }), headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  expect((await store.repo.keyAssignments.listByKey(k.id))).toHaveLength(1)
})

test('POST /:id/assign self-share → 400', async () => {
  await store.repo.users.create({ id: 'u1', name: 'A', createdAt: 'x', disabled: false })
  const k = await createApiKey('k', 'u1')
  const res = await buildApp({ isUser: true, userId: 'u1' }).request(`/api/keys/${k.id}/assign`, {
    method: 'POST', body: JSON.stringify({ user_id: 'u1' }), headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /:id/assign duplicate → 409', async () => {
  await store.repo.users.create({ id: 'u2', name: 'B', createdAt: 'x', disabled: false })
  const k = await createApiKey('k', 'u1')
  await store.repo.keyAssignments.assign(k.id, 'u2', 'u1')
  const res = await buildApp({ isAdmin: true }).request(`/api/keys/${k.id}/assign`, {
    method: 'POST', body: JSON.stringify({ user_id: 'u2' }), headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(409)
})

test('POST /:id/assign unknown user → 404', async () => {
  const k = await createApiKey('k', 'u1')
  const res = await buildApp({ isAdmin: true }).request(`/api/keys/${k.id}/assign`, {
    method: 'POST', body: JSON.stringify({ user_id: 'missing' }), headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(404)
})

test('GET /:id/assignments lists with user_name', async () => {
  await store.repo.users.create({ id: 'u2', name: 'Bob', createdAt: 'x', disabled: false })
  const k = await createApiKey('k', 'u1')
  await store.repo.keyAssignments.assign(k.id, 'u2', 'u1')
  const res = await buildApp({ isAdmin: true }).request(`/api/keys/${k.id}/assignments`)
  const body = await res.json() as any[]
  expect(body).toEqual([{ key_id: k.id, user_id: 'u2', user_name: 'Bob', assigned_by: 'u1', assigned_at: expect.any(String) }])
})

test('POST /:id/copy-web-search-from copies as refs', async () => {
  const src = await createApiKey('src', 'u1')
  src.webSearchLangsearchKey = 'literal-langsearch'
  src.webSearchTavilyKey = 'literal-tavily'
  src.webSearchPriority = ['langsearch', 'tavily']
  await store.repo.apiKeys.save(src)
  const target = await createApiKey('target', 'u1')
  const res = await buildApp({ isAdmin: true }).request(`/api/keys/${target.id}/copy-web-search-from/${src.id}`, { method: 'POST' })
  expect(res.status).toBe(200)
  const after = await store.repo.apiKeys.getById(target.id)
  expect(after?.webSearchLangsearchRef).toBe(src.id)
  expect(after?.webSearchTavilyRef).toBe(src.id)
  expect(after?.webSearchMsGroundingRef).toBeUndefined()
})

test('DELETE /:id/assign/:userId removes assignment', async () => {
  await store.repo.users.create({ id: 'u2', name: 'B', createdAt: 'x', disabled: false })
  const k = await createApiKey('k', 'u1')
  await store.repo.keyAssignments.assign(k.id, 'u2', 'u1')
  const res = await buildApp({ isAdmin: true }).request(`/api/keys/${k.id}/assign/u2`, { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(await store.repo.keyAssignments.listByKey(k.id)).toEqual([])
})

test('GET /:id/web-search-usage returns aggregated zeros when no data', async () => {
  const k = await createApiKey('k', 'u1')
  const res = await buildApp({ isAdmin: true }).request(`/api/keys/${k.id}/web-search-usage?range=7d`)
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body).toMatchObject({ range: '7d', days: 7, searches: 0, successes: 0, failures: 0 })
})
