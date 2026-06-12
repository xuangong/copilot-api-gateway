/**
 * Control-plane upstreams router tests — Week 5a-impl.
 *
 * Covers the 8 endpoints ported from old src/routes/control-plane.ts.
 * Uses an in-memory Repo + a pre-middleware to inject `c.set('auth', ...)`.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { setRepoForTest } from '../src/shared/repo/index.ts'
import type { Repo, UpstreamRecord, GitHubAccount } from '../src/shared/repo/types.ts'
import {
  upstreamsRouter,
  upstreamMiscRouter,
  type AuthCtx,
} from '../src/control-plane/upstreams/routes.ts'

function inMemoryRepo() {
  const upstreams = new Map<string, UpstreamRecord>()
  const deletedGithub: Array<{ userId: number; ownerId?: string }> = []
  const ghAccounts = new Map<string, GitHubAccount>()

  const repo = {
    upstreams: {
      list: async (opts?: { ownerId?: string; includeDisabled?: boolean }) => {
        let arr = [...upstreams.values()]
        if (opts?.ownerId !== undefined) arr = arr.filter((u) => u.ownerId === opts.ownerId)
        if (!opts?.includeDisabled) arr = arr.filter((u) => u.enabled)
        return arr
      },
      getById: async (id: string) => upstreams.get(id) ?? null,
      save: async (u: UpstreamRecord) => { upstreams.set(u.id, u) },
      delete: async (id: string) => upstreams.delete(id),
      deleteAll: async () => { upstreams.clear() },
    },
    github: {
      listAccounts: async () => [...ghAccounts.values()],
      listAccountsByOwner: async () => [],
      getAccount: async () => null,
      saveAccount: async (userId: number, a: GitHubAccount) => { ghAccounts.set(String(userId), a) },
      deleteAccount: async (userId: number, ownerId?: string) => {
        deletedGithub.push({ userId, ownerId })
        ghAccounts.delete(String(userId))
      },
      deleteAllAccounts: async () => { ghAccounts.clear() },
      getActiveId: async () => null,
      setActiveId: async () => { },
      clearActiveId: async () => { },
      getActiveIdForUser: async () => null,
      setActiveIdForUser: async () => { },
      clearActiveIdForUser: async () => { },
    },
  } as unknown as Repo

  return { repo, upstreams, deletedGithub }
}

function buildApp(auth: AuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api/upstreams', upstreamsRouter)
  app.route('/api', upstreamMiscRouter)
  return app
}

function copilotUpstream(over: Partial<UpstreamRecord> = {}): UpstreamRecord {
  const now = new Date().toISOString()
  return {
    id: 'up_copilot_acme_abcd1234',
    provider: 'copilot',
    name: 'acme',
    enabled: true,
    sortOrder: 0,
    config: { githubToken: 'gh_secret', accountType: 'individual', user: { id: 42 } },
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

let store: ReturnType<typeof inMemoryRepo>

beforeEach(() => {
  store = inMemoryRepo()
  setRepoForTest(store.repo)
})

test('GET /api/upstream-flags as admin returns catalog', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstream-flags')
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(Array.isArray(body.catalog)).toBe(true)
  expect(body.defaults).toHaveProperty('copilot')
  expect(body.defaults).toHaveProperty('custom')
  expect(body.defaults).toHaveProperty('azure')
})

test('GET /api/upstream-flags non-admin → 403', async () => {
  const res = await buildApp({}).request('/api/upstream-flags')
  expect(res.status).toBe(403)
})

test('POST /api/upstream-probe non-admin → 403', async () => {
  const res = await buildApp({}).request('/api/upstream-probe', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(403)
})

test('POST /api/upstream-probe missing fields → 400', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstream-probe', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /api/upstream-probe copilot → 400 explanatory', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstream-probe', {
    method: 'POST',
    body: JSON.stringify({ kind: 'copilot', config: { foo: 1 } }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /api/upstream-probe custom valid config → ok via probe', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ object: 'list', data: [{ id: 'm1' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  try {
    const res = await buildApp({ isAdmin: true }).request('/api/upstream-probe', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'custom',
        config: { name: 'x', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' },
      }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok?: boolean }
    expect(body.ok).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('POST /api/upstream-probe azure valid config → ok via probe', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  try {
    const res = await buildApp({ isAdmin: true }).request('/api/upstream-probe', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'azure',
        config: {
          name: 'a', endpoint: 'https://az.example', apiKey: 'k',
          deployment: 'd', apiVersion: '2024-02-15-preview',
        },
      }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok?: boolean }
    expect(body.ok).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('POST /api/upstream-probe custom missing apiKey → 400', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstream-probe', {
    method: 'POST',
    body: JSON.stringify({ kind: 'custom', config: { name: 'x', baseUrl: 'https://e.com' } }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /api/upstream-probe azure missing deployment → 400', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstream-probe', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'azure',
      config: { name: 'a', endpoint: 'https://az.example', apiKey: 'k', apiVersion: '2024-02-15-preview' },
    }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('GET /api/upstreams non-admin → 403', async () => {
  const res = await buildApp({}).request('/api/upstreams')
  expect(res.status).toBe(403)
})

test('GET /api/upstreams returns redacted secrets', async () => {
  await store.repo.upstreams.save(copilotUpstream())
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams')
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.upstreams).toHaveLength(1)
  expect(body.upstreams[0].config.githubToken).toBe('***')
})

test('GET /api/upstreams?includeDisabled=1 includes disabled', async () => {
  await store.repo.upstreams.save(copilotUpstream({ id: 'a', enabled: true }))
  await store.repo.upstreams.save(copilotUpstream({ id: 'b', enabled: false }))
  const r1 = await buildApp({ isAdmin: true }).request('/api/upstreams')
  expect(((await r1.json()) as any).upstreams).toHaveLength(1)
  const r2 = await buildApp({ isAdmin: true }).request('/api/upstreams?includeDisabled=1')
  expect(((await r2.json()) as any).upstreams).toHaveLength(2)
})

test('POST /api/upstreams unknown provider → 400', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({ provider: 'fancy', name: 'x', config: {} }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /api/upstreams copilot missing token → 400', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({ provider: 'copilot', name: 'acme', config: { accountType: 'individual' } }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /api/upstreams custom create → 201', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      name: 'my-llm',
      config: { name: 'my-llm', baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-secret' },
    }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(201)
  const body = await res.json() as any
  expect(body.upstream.provider).toBe('custom')
  expect(body.upstream.config.apiKey).toBe('***')
  expect(body.upstream.config.baseUrl).toBe('https://api.example.com/v1')
})

test('PATCH /api/upstreams/:id provider cannot change → 400', async () => {
  const u = copilotUpstream()
  await store.repo.upstreams.save(u)
  const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${u.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ provider: 'azure' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('PATCH /api/upstreams/:id copilot config locked → 400', async () => {
  const u = copilotUpstream()
  await store.repo.upstreams.save(u)
  const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${u.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ config: { githubToken: 'new' } }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('PATCH /api/upstreams/:id rename + flagOverrides', async () => {
  const u = copilotUpstream()
  await store.repo.upstreams.save(u)
  const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${u.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'renamed', enabled: false }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.upstream.name).toBe('renamed')
  expect(body.upstream.enabled).toBe(false)
})

test('PATCH custom with *** sentinel preserves existing secret', async () => {
  const now = new Date().toISOString()
  const u: UpstreamRecord = {
    id: 'up_custom_my_aaaa1111',
    provider: 'custom',
    name: 'my',
    enabled: true,
    sortOrder: 0,
    config: { name: 'my', baseUrl: 'https://e.com', apiKey: 'real-secret', endpoints: ['chat_completions'] },
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: now,
    updatedAt: now,
  }
  await store.repo.upstreams.save(u)
  const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${u.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ config: { apiKey: '***', baseUrl: 'https://e2.com' } }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const after = await store.repo.upstreams.getById(u.id)
  expect((after?.config as any).apiKey).toBe('real-secret')
  expect((after?.config as any).baseUrl).toBe('https://e2.com')
})

test('DELETE /api/upstreams/:id missing → 404', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams/nope', { method: 'DELETE' })
  expect(res.status).toBe(404)
})

test('DELETE copilot upstream cascades to github_accounts', async () => {
  const u = copilotUpstream()
  await store.repo.upstreams.save(u)
  const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${u.id}`, { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(store.deletedGithub).toEqual([{ userId: 42, ownerId: '' }])
  expect(store.upstreams.has(u.id)).toBe(false)
})

test('POST /api/upstreams/:id/test missing → 404', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams/nope/test', { method: 'POST' })
  expect(res.status).toBe(404)
})

test('POST /api/upstreams/:id/test custom → 200 via probe', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ object: 'list', data: [{ id: 'm1' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  try {
    const now = new Date().toISOString()
    const u: UpstreamRecord = {
      id: 'up_custom_a_aaaaaaaa',
      provider: 'custom',
      name: 'a',
      enabled: true,
      sortOrder: 0,
      config: { name: 'a', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', endpoints: ['chat_completions'] },
      flagOverrides: {},
      disabledPublicModelIds: [],
      createdAt: now, updatedAt: now,
    }
    await store.repo.upstreams.save(u)
    const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${u.id}/test`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok?: boolean }
    expect(body.ok).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('POST /api/upstreams/:id/test azure → 200 via probe', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  try {
    const now = new Date().toISOString()
    const u: UpstreamRecord = {
      id: 'up_azure_a_aaaaaaaa',
      provider: 'azure',
      name: 'a',
      enabled: true,
      sortOrder: 0,
      config: {
        name: 'a', endpoint: 'https://az.example', apiKey: 'k',
        deployment: 'd', apiVersion: '2024-02-15-preview', endpoints: ['chat_completions'],
      },
      flagOverrides: {},
      disabledPublicModelIds: [],
      createdAt: now, updatedAt: now,
    }
    await store.repo.upstreams.save(u)
    const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${u.id}/test`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok?: boolean }
    expect(body.ok).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET /api/upstreams/:id/models missing → 404', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams/nope/models')
  expect(res.status).toBe(404)
})
