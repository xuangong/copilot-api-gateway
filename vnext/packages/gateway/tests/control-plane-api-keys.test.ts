/**
 * Control-plane api-keys router tests — Week 5a-impl.
 *
 * Covers the 11 endpoints ported from old src/routes/api-keys.ts. Uses an
 * in-memory Repo + a small pre-middleware to inject `c.set('auth', {...})`
 * since no auth middleware has been ported yet.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/repo/index.ts'
import type {
  ApiKey,
  KeyAssignment,
  Repo,
  User,
  WebSearchUsageRecord,
  WebSearchEngineUsageRecord,
} from '../src/repo/types.ts'
import { apiKeysRouter, type AuthCtx } from '../src/control-plane/api-keys/routes.ts'
import { createApiKey } from '../src/control-plane/lib/api-keys.ts'
import { initRuntimeLocation, __resetPlatformForTests } from '@vibe-core/platform'

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
      patchModelMappings: async (id: string, patch: { modelMappingsEnabled?: boolean; modelMappings?: ApiKey['modelMappings'] }) => {
        const current = keys.get(id)
        if (!current) return false
        keys.set(id, {
          ...current,
          ...(patch.modelMappingsEnabled !== undefined && { modelMappingsEnabled: patch.modelMappingsEnabled }),
          ...(patch.modelMappings !== undefined && { modelMappings: patch.modelMappings }),
          modelMappingsInvalid: false,
        })
        return true
      },
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
  __resetPlatformForTests()
  initRuntimeLocation('bun')
  store = inMemoryRepo()
  initRepo(store.repo)
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
    body: JSON.stringify({ name: 'renamed', quota_requests_per_month: 100 }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.name).toBe('renamed')
  expect(body.quota_requests_per_month).toBe(100)
})

test('PATCH cost quota round-trips through GET', async () => {
  const k = await createApiKey('k1', 'u1')
  const app = buildApp({ isAdmin: true })
  const patched = await app.request(`/api/keys/${k.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ quota_cost_per_month: 12.5 }),
    headers: { 'content-type': 'application/json' },
  })
  expect(patched.status).toBe(200)
  expect((await patched.json() as any).quota_cost_per_month).toBe(12.5)

  const listed = await (await app.request('/api/keys')).json() as any[]
  expect(listed.find((r) => r.id === k.id).quota_cost_per_month).toBe(12.5)

  const cleared = await app.request(`/api/keys/${k.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ quota_cost_per_month: null }),
    headers: { 'content-type': 'application/json' },
  })
  expect((await cleared.json() as any).quota_cost_per_month).toBeNull()
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

// Cross-tenant regression. Every one of these routes used to spell the owner
// comparison itself; they now share loadOwned. The pair of assertions per route
// matters as much as the status: a foreign key and a nonexistent key must be
// answered identically, or the status code enumerates other users' key ids.
const FOREIGN_ROUTES: Array<{ name: string; path: (id: string) => string; init?: RequestInit }> = [
  { name: 'GET /:id', path: (id) => `/api/keys/${id}` },
  {
    name: 'PATCH /:id',
    path: (id) => `/api/keys/${id}`,
    init: { method: 'PATCH', body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json' } },
  },
  { name: 'POST /:id/rotate', path: (id) => `/api/keys/${id}/rotate`, init: { method: 'POST' } },
  { name: 'DELETE /:id', path: (id) => `/api/keys/${id}`, init: { method: 'DELETE' } },
]

for (const route of FOREIGN_ROUTES) {
  test(`${route.name} refuses another user's key, indistinguishably from a missing one`, async () => {
    const victim = await createApiKey('victim', 'u1')
    const attacker = buildApp({ isUser: true, userId: 'u2' })

    const foreign = await attacker.request(route.path(victim.id), route.init)
    const missing = await attacker.request(route.path('key_does_not_exist'), route.init)

    expect(foreign.status).toBe(403)
    expect(missing.status).toBe(foreign.status)
    // The victim's key must survive the refused DELETE / PATCH.
    expect(await store.repo.apiKeys.getById(victim.id)).not.toBeNull()
  })
}

test('an anonymous caller (no admin, no user) is refused an existing key', async () => {
  const victim = await createApiKey('victim', 'u1')
  const res = await buildApp({}).request(`/api/keys/${victim.id}`)
  expect(res.status).toBe(403)
})

interface MappingJson {
  source: string
  destination: string
}

interface MappingKeyJson {
  model_mappings_enabled: boolean
  model_mappings: MappingJson[]
  model_mappings_invalid: boolean
  modelMappingsEnabled: boolean
  modelMappings: MappingJson[]
  modelMappingsInvalid: boolean
  can_manage_model_mappings: boolean
  canManageModelMappings: boolean
}

async function patchKey(app: Hono, id: string, body: unknown): Promise<Response> {
  return app.request(`/api/keys/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

test('GET list and assigned detail expose dual mapping fields and mapping permission', async () => {
  const key = await createApiKey('shared', 'owner')
  key.modelMappingsEnabled = true
  key.modelMappings = [{ source: 'source', destination: 'destination' }]
  await store.repo.apiKeys.save(key)
  await store.repo.keyAssignments.assign(key.id, 'assignee', 'owner')

  const app = buildApp({ isUser: true, userId: 'assignee' })
  const list = await app.request('/api/keys')
  const listEntry = (await list.json() as MappingKeyJson[]).at(0)
  expect(listEntry).toBeDefined()
  expect(listEntry).toMatchObject({
    model_mappings_enabled: true,
    model_mappings: [{ source: 'source', destination: 'destination' }],
    model_mappings_invalid: false,
    modelMappingsEnabled: true,
    modelMappings: [{ source: 'source', destination: 'destination' }],
    modelMappingsInvalid: false,
    can_manage_model_mappings: true,
    canManageModelMappings: true,
  })

  const detail = await app.request(`/api/keys/${key.id}`)
  expect(detail.status).toBe(200)
  expect((await detail.json() as MappingKeyJson).can_manage_model_mappings).toBe(true)

  const apiKeyList = await buildApp({ apiKeyId: key.id }).request('/api/keys')
  const apiKeyEntry = (await apiKeyList.json() as MappingKeyJson[]).at(0)
  expect(apiKeyEntry).toBeDefined()
  expect(apiKeyEntry?.can_manage_model_mappings).toBe(false)
})

test('admin and owner GET list and detail expose snake and camel mapping capability', async () => {
  const key = await createApiKey('key', 'owner')
  for (const auth of [{ isAdmin: true }, { isUser: true, userId: 'owner' }] satisfies AuthCtx[]) {
    const app = buildApp(auth)
    const list = await app.request('/api/keys')
    const rows = await list.json() as MappingKeyJson[]
    const row = rows.at(0)
    expect(row).toBeDefined()
    expect(row?.can_manage_model_mappings).toBe(true)
    expect(row?.canManageModelMappings).toBe(true)
    const detail = await app.request(`/api/keys/${key.id}`)
    const body = await detail.json() as MappingKeyJson
    expect(body.can_manage_model_mappings).toBe(true)
    expect(body.canManageModelMappings).toBe(true)
  }
})

test('mapping PATCH denies unrelated user, authenticated API key, and anonymous callers', async () => {
  const key = await createApiKey('key', 'owner')
  for (const auth of [
    { isUser: true, userId: 'unrelated' },
    { apiKeyId: key.id },
    {},
  ] satisfies AuthCtx[]) {
    const response = await patchKey(buildApp(auth), key.id, { model_mappings: [] })
    expect(response.status).toBe(403)
  }
})

test('mapping PATCH hides missing and foreign keys identically', async () => {
  const foreignKey = await createApiKey('foreign', 'owner')
  const app = buildApp({ isUser: true, userId: 'unrelated' })
  const body = { model_mappings: [] }
  const foreign = await patchKey(app, foreignKey.id, body)
  const missing = await patchKey(app, 'key_missing', body)
  expect(foreign.status).toBe(missing.status)
  expect(await foreign.json()).toEqual(await missing.json())
})

test('PATCH both mapping fields saves once atomically', async () => {
  const key = await createApiKey('key', 'owner')
  let patches = 0
  const realPatch = store.repo.apiKeys.patchModelMappings
  store.repo.apiKeys.patchModelMappings = async (id, patch) => { patches++; return realPatch(id, patch) }
  const result = await patchKey(buildApp({ isUser: true, userId: 'owner' }), key.id, {
    model_mappings_enabled: true, model_mappings: [],
  })
  expect(result.status).toBe(200)
  expect(patches).toBe(1)
  const stored = await store.repo.apiKeys.getById(key.id)
  expect(stored?.modelMappingsEnabled).toBe(true)
  expect(stored?.modelMappings).toEqual([])
})

test('PATCH mappings accepts snake case only and preserves omitted mapping fields', async () => {
  const key = await createApiKey('key', 'owner')
  const owner = buildApp({ isUser: true, userId: 'owner' })

  const initial = await patchKey(owner, key.id, { model_mappings: [] })
  expect(initial.status).toBe(200)
  const initialJson = await initial.json() as MappingKeyJson
  expect(initialJson.model_mappings_enabled).toBe(false)
  expect(initialJson.model_mappings).toEqual([])

  const camelOnly = await patchKey(owner, key.id, { modelMappingsEnabled: true })
  expect(camelOnly.status).toBe(200)
  expect((await camelOnly.json() as MappingKeyJson).model_mappings_enabled).toBe(false)

  const enabled = await patchKey(owner, key.id, { model_mappings_enabled: true })
  expect(enabled.status).toBe(200)
  expect((await enabled.json() as MappingKeyJson).model_mappings).toEqual([])
})

test('GET fails closed for corrupt stored mappings', async () => {
  const key = await createApiKey('key', 'owner')
  key.modelMappingsEnabled = true
  key.modelMappings = [{ source: 'source', destination: 'destination' }]
  key.modelMappingsInvalid = true
  await store.repo.apiKeys.save(key)
  const result = await buildApp({ isUser: true, userId: 'owner' }).request(`/api/keys/${key.id}`)
  const body = await result.json() as MappingKeyJson
  expect(body.model_mappings_enabled).toBe(false)
  expect(body.model_mappings).toEqual([])
  expect(body.model_mappings_invalid).toBe(true)
})

test('PATCH mapping boundaries and exact keys are enforced', async () => {
  const key = await createApiKey('key', 'owner')
  const app = buildApp({ isUser: true, userId: 'owner' })
  const exactMax = Array.from({ length: 100 }, (_, index) => ({ source: `source-${index}`, destination: `direct-${index}` }))
  store.repo.upstreams = {
    list: async (filter: { ownerId?: string } = {}) => filter.ownerId === 'owner' ? [{
      id: 'copilot:owner', provider: 'copilot', name: 'owner', ownerId: 'owner', enabled: true, sortOrder: 0,
      config: { githubToken: 'token' }, flagOverrides: {}, disabledPublicModelIds: [], state: null,
      proxyFallbackList: [{ id: 'direct_fetch' }], createdAt: 'x', updatedAt: 'boundaries',
    }] : [],
  } as Repo['upstreams']
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const payload = String(input).includes('/copilot_internal/v2/token')
      ? { token: 'copilot-token', expires_at: Math.floor(Date.now() / 1000) + 3600 }
      : { object: 'list', data: [...exactMax.map((mapping) => ({ id: mapping.destination, object: 'model', name: mapping.destination, vendor: 'openai', version: mapping.destination, model_picker_enabled: true, preview: false, capabilities: { family: 'openai', limits: {}, supports: {}, tokenizer: 'x', type: 'text' } })), ...['d'.repeat(256)].map((id) => ({ id, object: 'model', name: id, vendor: 'openai', version: id, model_picker_enabled: true, preview: false, capabilities: { family: 'openai', limits: {}, supports: {}, tokenizer: 'x', type: 'text' } }))] }
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
  try {
  expect((await patchKey(app, key.id, { model_mappings: exactMax })).status).toBe(200)
  expect((await patchKey(app, key.id, { model_mappings: [...exactMax, { source: 'x', destination: 'y' }] })).status).toBe(400)
  expect((await patchKey(app, key.id, { model_mappings: [{ source: 's'.repeat(256), destination: 'd'.repeat(256) }] })).status).toBe(200)
  expect((await patchKey(app, key.id, { model_mappings: [{ source: 's'.repeat(257), destination: 'd' }] })).status).toBe(400)
  expect((await patchKey(app, key.id, { model_mappings: [{ source: 's', destination: 'd', extra: true }] })).status).toBe(400)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('PATCH rejects malformed mapping configuration without saving', async () => {
  const key = await createApiKey('key', 'owner')
  const app = buildApp({ isUser: true, userId: 'owner' })
  const malformed = await patchKey(app, key.id, {
    model_mappings_enabled: 'true',
    model_mappings: [{ source: 'a', destination: 'b', extra: true }],
  })
  expect(malformed.status).toBe(400)
  const error = await malformed.json() as { error: string }
  expect(error.error).toMatch(/model_mappings_enabled/)
  expect((await store.repo.apiKeys.getById(key.id))?.modelMappingsEnabled).toBe(false)

  const badItem = await patchKey(app, key.id, { model_mappings: [{ source: ' ', destination: 'b' }] })
  expect(badItem.status).toBe(400)
  expect((await badItem.json() as { error: string }).error).toMatch(/index 0.*source/)
})

test('mapping-only and enabled-only PATCH preserve omitted mapping values', async () => {
  const key = await createApiKey('key', 'owner')
  key.modelMappingsEnabled = true
  key.modelMappings = [{ source: 'one', destination: 'two' }]
  await store.repo.apiKeys.save(key)
  const app = buildApp({ isUser: true, userId: 'owner' })
  const mappingOnly = await patchKey(app, key.id, { model_mappings: [] })
  expect((await mappingOnly.json() as MappingKeyJson).model_mappings_enabled).toBe(true)
  const current = await store.repo.apiKeys.getById(key.id)
  if (!current) throw new Error('expected key')
  current.modelMappings = []
  await store.repo.apiKeys.save(current)
  const enableOnly = await patchKey(app, key.id, { model_mappings_enabled: false })
  expect((await enableOnly.json() as MappingKeyJson).model_mappings).toEqual([])
})

test('explicit empty mappings skip catalog validation', async () => {
  const key = await createApiKey('key', 'owner')
  let catalogCalls = 0
  store.repo.upstreams = {
    list: async () => { catalogCalls++; throw new Error('must not fetch') },
  } as Repo['upstreams']
  const result = await patchKey(buildApp({ isUser: true, userId: 'owner' }), key.id, { model_mappings: [] })
  expect(result.status).toBe(200)
  expect(catalogCalls).toBe(0)
})

test('PATCH validates mapping destinations against the key owner catalog', async () => {
  const key = await createApiKey('key', 'owner')
  const upstream = {
    id: 'copilot:owner', provider: 'copilot', name: 'owner', ownerId: 'owner', enabled: true,
    sortOrder: 0, config: { githubToken: 'token' }, flagOverrides: {}, disabledPublicModelIds: [],
    state: null, proxyFallbackList: [{ id: 'direct_fetch' }], createdAt: 'x', updatedAt: 'x',
  }
  store.repo.upstreams = {
    list: async (filter: { ownerId?: string } = {}) => filter.ownerId === 'owner' ? [upstream] : [],
  } as Repo['upstreams']
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.includes('/copilot_internal/v2/token')
      ? { token: 'copilot-token', expires_at: Math.floor(Date.now() / 1000) + 3600 }
      : { object: 'list', data: [{

      id: 'claude-opus-4.7', object: 'model', name: 'Claude', vendor: 'anthropic', version: 'claude-opus-4.7',
      model_picker_enabled: true, preview: false,
      capabilities: { family: 'anthropic', limits: {}, supports: {}, tokenizer: 'x', type: 'text' },
    }, {
      id: 'claude-opus-4.7-xhigh-1m', object: 'model', name: 'Claude', vendor: 'anthropic', version: 'claude-opus-4.7-xhigh-1m',
      model_picker_enabled: true, preview: false,
      capabilities: { family: 'anthropic', limits: { max_context_window_tokens: 1_000_000 }, supports: { reasoning_effort: ['xhigh'] }, tokenizer: 'x', type: 'text' },
    }] }
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
  try {
    const app = buildApp({ isUser: true, userId: 'owner' })
    const valid = await patchKey(app, key.id, { model_mappings: [{ source: 'source', destination: 'claude-opus-4.7-xhigh-1m' }] })
    expect(valid.status).toBe(200)
    const invalid = await patchKey(app, key.id, { model_mappings: [{ source: 'source', destination: 'missing' }] })
    expect(invalid.status).toBe(400)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('PATCH returns generic 503 without saving when catalog discovery fails', async () => {
  const key = await createApiKey('key', 'owner')
  let saves = 0
  const realSave = store.repo.apiKeys.save
  store.repo.apiKeys.save = async (updated) => { saves++; await realSave(updated) }
  store.repo.upstreams = {
    list: async () => { throw new Error('catalog discovery failed') },
  } as Repo['upstreams']
  const result = await patchKey(buildApp({ isUser: true, userId: 'owner' }), key.id, {
    model_mappings: [{ source: 'missing-source-is-valid', destination: 'destination' }],
  })
  expect(result.status).toBe(503)
  expect(await result.json()).toEqual({ error: 'Unable to validate model mappings' })
  expect(saves).toBe(0)
})

test('ownerless key is only manageable by an admin', async () => {
  const key = await createApiKey('key')
  await store.repo.keyAssignments.assign(key.id, 'assignee', 'admin')
  const assignee = buildApp({ isUser: true, userId: 'assignee' })
  expect((await assignee.request(`/api/keys/${key.id}`)).status).toBe(403)
  expect((await patchKey(assignee, key.id, { model_mappings: [] })).status).toBe(403)
  const admin = buildApp({ isAdmin: true })
  expect((await admin.request(`/api/keys/${key.id}`)).status).toBe(200)
})

test('owner PATCH persists and clears web search passthrough fields', async () => {
  const key = await createApiKey('key', 'owner')
  const app = buildApp({ isUser: true, userId: 'owner' })
  const set = await patchKey(app, key.id, {
    web_search_passthrough_upstream: 'upstream-a', web_search_passthrough_model: 'model-a',
  })
  expect(set.status).toBe(200)
  expect((await store.repo.apiKeys.getById(key.id))?.webSearchPassthroughUpstream).toBe('upstream-a')
  const clear = await patchKey(app, key.id, {
    web_search_passthrough_upstream: null, web_search_passthrough_model: null,
  })
  expect(clear.status).toBe(200)
  expect((await store.repo.apiKeys.getById(key.id))?.webSearchPassthroughUpstream).toBeUndefined()
})

test('assignee may change only model mappings and cannot combine another mutable field', async () => {
  const key = await createApiKey('key', 'owner')
  await store.repo.keyAssignments.assign(key.id, 'assignee', 'owner')
  const app = buildApp({ isUser: true, userId: 'assignee' })

  const mappingOnly = await patchKey(app, key.id, { model_mappings_enabled: true, model_mappings: [] })
  expect(mappingOnly.status).toBe(200)
  expect((await store.repo.apiKeys.getById(key.id))?.modelMappingsEnabled).toBe(true)

  const mixed = await patchKey(app, key.id, { model_mappings_enabled: false, name: 'stolen' })
  expect(mixed.status).toBe(403)
  const stored = await store.repo.apiKeys.getById(key.id)
  expect(stored?.name).toBe('key')
  expect(stored?.modelMappingsEnabled).toBe(true)
})

function installOwnerCatalog(models: Array<Record<string, unknown>>, enabled = true): () => void {
  store.repo.upstreams = {
    list: async (filter: { ownerId?: string } = {}) => filter.ownerId === 'owner' ? [{
      id: 'copilot:owner', provider: 'copilot', name: 'owner', ownerId: 'owner', enabled, sortOrder: 0,
      config: { githubToken: 'token' }, flagOverrides: {}, disabledPublicModelIds: [], state: null,
      proxyFallbackList: [{ id: 'direct_fetch' }], createdAt: 'x', updatedAt: `catalog-${enabled}`,
    }] : [],
  } as Repo['upstreams']
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const payload = String(input).includes('/copilot_internal/v2/token')
      ? { token: 'copilot-token', expires_at: Math.floor(Date.now() / 1000) + 3600 }
      : { object: 'list', data: models }
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
  return () => { globalThis.fetch = originalFetch }
}

function catalogModel(id: string, supports: Record<string, unknown> = {}, maxContext = 200_000): Record<string, unknown> {
  return {
    id, object: 'model', name: id, vendor: 'anthropic', version: id, model_picker_enabled: true, preview: false,
    capabilities: { family: 'anthropic', limits: { max_context_window_tokens: maxContext }, supports, tokenizer: 'x', type: 'text' },
  }
}

test('PATCH accepts a composite built from split raw variants within one upstream', async () => {
  const key = await createApiKey('key', 'owner')
  const restore = installOwnerCatalog([
    catalogModel('claude-opus-4.7-xhigh', { reasoning_effort: ['xhigh'] }),
    catalogModel('claude-opus-4.7-1m-internal', {}, 1_000_000),
  ])
  try {
    const response = await patchKey(buildApp({ isUser: true, userId: 'owner' }), key.id, {
      model_mappings: [{ source: 'alias', destination: 'claude-opus-4.7-xhigh-1m' }],
    })
    expect(response.status).toBe(200)
  } finally {
    restore()
  }
})

test('assignee mapping PATCH does not overwrite concurrent owner fields while catalog awaits', async () => {
  const key = await createApiKey('key', 'owner')
  await store.repo.keyAssignments.assign(key.id, 'assignee', 'owner')
  store.repo.upstreams = {
    list: async (filter: { ownerId?: string } = {}) => filter.ownerId === 'owner' ? [{
      id: 'copilot:owner', provider: 'copilot', name: 'owner', ownerId: 'owner', enabled: true, sortOrder: 0,
      config: { githubToken: 'token' }, flagOverrides: {}, disabledPublicModelIds: [], state: null,
      proxyFallbackList: [{ id: 'direct_fetch' }], createdAt: 'x', updatedAt: 'concurrent-catalog',
    }] : [],
  } as Repo['upstreams']
  let notifyCatalogStarted: (() => void) | undefined
  const catalogStarted = new Promise<void>((resolve) => { notifyCatalogStarted = resolve })
  let resolveCatalog: ((response: Response) => void) | undefined
  const catalogResponse = new Promise<Response>((resolve) => { resolveCatalog = resolve })
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (String(input).includes('/copilot_internal/v2/token')) {
      return Promise.resolve(new Response(JSON.stringify({ token: 'copilot-token', expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 }))
    }
    notifyCatalogStarted?.()
    return catalogResponse
  }) as typeof fetch
  let saves = 0
  let patches = 0
  const realSave = store.repo.apiKeys.save
  const realPatch = store.repo.apiKeys.patchModelMappings
  store.repo.apiKeys.save = async (updated) => { saves++; await realSave(updated) }
  store.repo.apiKeys.patchModelMappings = async (id, patch) => { patches++; return realPatch(id, patch) }
  try {
    const request = patchKey(buildApp({ isUser: true, userId: 'assignee' }), key.id, {
      model_mappings: [{ source: 'alias', destination: 'direct-target' }],
    })
    await catalogStarted
    const concurrent = await store.repo.apiKeys.getById(key.id)
    if (!concurrent) throw new Error('expected key')
    await store.repo.apiKeys.save({ ...concurrent, name: 'owner-update', quotaRequestsPerMonth: 99 })
    saves = 0
    if (!resolveCatalog) throw new Error('expected catalog resolver')
    resolveCatalog(new Response(JSON.stringify({ object: 'list', data: [catalogModel('direct-target')] }), { status: 200 }))
    const response = await request
    expect(response.status).toBe(200)
    expect(saves).toBe(0)
    expect(patches).toBe(1)
    expect(await store.repo.apiKeys.getById(key.id)).toMatchObject({
      name: 'owner-update', quotaRequestsPerMonth: 99,
      modelMappings: [{ source: 'alias', destination: 'direct-target' }],
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('PATCH rejects a destination from a disabled upstream without saving mappings', async () => {
  const key = await createApiKey('key', 'owner')
  const restore = installOwnerCatalog([catalogModel('direct-target')], false)
  try {
    const response = await patchKey(buildApp({ isUser: true, userId: 'owner' }), key.id, {
      model_mappings: [{ source: 'alias', destination: 'direct-target' }],
    })
    expect(response.status).toBe(400)
    expect((await store.repo.apiKeys.getById(key.id))?.modelMappings).not.toEqual([{ source: 'alias', destination: 'direct-target' }])
  } finally {
    restore()
  }
})

test('PATCH accepts a source absent from a successful catalog when destination is direct', async () => {
  const key = await createApiKey('key', 'owner')
  const restore = installOwnerCatalog([catalogModel('direct-target')])
  try {
    const response = await patchKey(buildApp({ isUser: true, userId: 'owner' }), key.id, {
      model_mappings: [{ source: 'unlisted-alias', destination: 'direct-target' }],
    })
    expect(response.status).toBe(200)
    expect((await store.repo.apiKeys.getById(key.id))?.modelMappings).toEqual([{ source: 'unlisted-alias', destination: 'direct-target' }])
  } finally {
    restore()
  }
})

test('enabled-only PATCH retains a nonempty mapping list in response and repository', async () => {
  const key = await createApiKey('key', 'owner')
  key.modelMappings = [{ source: 'source', destination: 'destination' }]
  await store.repo.apiKeys.save(key)
  const restore = installOwnerCatalog([catalogModel('destination')])
  try {
    const response = await patchKey(buildApp({ isUser: true, userId: 'owner' }), key.id, { model_mappings_enabled: true })
    const body = await response.json() as MappingKeyJson
    expect(response.status).toBe(200)
    expect(body.model_mappings).toEqual([{ source: 'source', destination: 'destination' }])
    expect((await store.repo.apiKeys.getById(key.id))?.modelMappings).toEqual([{ source: 'source', destination: 'destination' }])
  } finally {
    restore()
  }
})

test('camel-only PATCH does not save or change stored mapping settings', async () => {
  const key = await createApiKey('key', 'owner')
  let saves = 0
  const realSave = store.repo.apiKeys.save
  store.repo.apiKeys.save = async (updated) => { saves++; await realSave(updated) }
  const response = await patchKey(buildApp({ isUser: true, userId: 'owner' }), key.id, { modelMappingsEnabled: true })
  expect(response.status).toBe(200)
  expect(saves).toBe(1)
  expect((await store.repo.apiKeys.getById(key.id))?.modelMappingsEnabled).toBe(false)
})

test('valid catalog PATCH preserves duplicate source order self mappings and trimmed response', async () => {
  const key = await createApiKey('key', 'owner')
  const restore = installOwnerCatalog([catalogModel('self'), catalogModel('destination')])
  const expected = [
    { source: 'self', destination: 'self' },
    { source: 'source', destination: 'destination' },
    { source: 'source', destination: 'destination' },
  ]
  try {
    const response = await patchKey(buildApp({ isUser: true, userId: 'owner' }), key.id, {
      model_mappings: [
        { source: ' self ', destination: ' self ' },
        { source: ' source ', destination: ' destination ' },
        { source: 'source', destination: 'destination' },
      ],
    })
    expect(response.status).toBe(200)
    expect((await response.json() as MappingKeyJson).model_mappings).toEqual(expected)
    expect((await store.repo.apiKeys.getById(key.id))?.modelMappings).toEqual(expected)
  } finally {
    restore()
  }
})
