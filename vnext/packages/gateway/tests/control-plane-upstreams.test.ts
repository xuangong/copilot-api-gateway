/**
 * Control-plane upstreams router tests — Week 5a-impl.
 *
 * Covers the 8 endpoints ported from old src/routes/control-plane.ts.
 * Uses an in-memory Repo + a pre-middleware to inject `c.set('auth', ...)`.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/repo/index.ts'
import { __resetPlatformForTests } from '@vibe-core/platform'
import type { Repo, UpstreamRecord, GitHubAccount } from '../src/repo/types.ts'
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
  initRepo(store.repo)
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
          name: 'a', endpoint: 'https://az.openai.azure.com', apiKey: 'k',
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

test('POST /api/upstream-probe custom missing apiKey → 200 { ok:false }', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstream-probe', {
    method: 'POST',
    body: JSON.stringify({ kind: 'custom', config: { name: 'x', baseUrl: 'https://e.com' } }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { ok?: boolean; error?: string }
  expect(body.ok).toBe(false)
  expect(typeof body.error).toBe('string')
})

test('POST /api/upstream-probe azure missing deployment → 200 { ok:false }', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstream-probe', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'azure',
      config: { name: 'a', endpoint: 'https://az.openai.azure.com', apiKey: 'k', apiVersion: '2024-02-15-preview' },
    }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { ok?: boolean; error?: string }
  expect(body.ok).toBe(false)
  expect(typeof body.error).toBe('string')
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
        name: 'a', endpoint: 'https://az.openai.azure.com', apiKey: 'k',
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

// Cross-tenant regression for the four owner-scoped upstream routes, which now
// share loadOwned instead of each re-deriving the comparison. A foreign upstream
// and a nonexistent one must be answered identically; otherwise the status code
// alone reveals which upstream ids exist under other owners.
const FOREIGN_ROUTES: Array<{ name: string; path: (id: string) => string; init?: RequestInit }> = [
  {
    name: 'PATCH /:id',
    path: (id) => `/api/upstreams/${id}`,
    init: { method: 'PATCH', body: JSON.stringify({ name: 'hijacked' }), headers: { 'content-type': 'application/json' } },
  },
  { name: 'DELETE /:id', path: (id) => `/api/upstreams/${id}`, init: { method: 'DELETE' } },
  { name: 'POST /:id/test', path: (id) => `/api/upstreams/${id}/test`, init: { method: 'POST' } },
  { name: 'GET /:id/models', path: (id) => `/api/upstreams/${id}/models` },
]

for (const route of FOREIGN_ROUTES) {
  test(`${route.name} refuses another user's upstream, indistinguishably from a missing one`, async () => {
    const victim = copilotUpstream({ ownerId: 'u1' })
    await store.repo.upstreams.save(victim)
    const attacker = buildApp({ isUser: true, userId: 'u2' })

    const foreign = await attacker.request(route.path(victim.id), route.init)
    const missing = await attacker.request(route.path('up_does_not_exist'), route.init)

    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(foreign.status)
    // Neither the record nor its cascade target may have been touched.
    expect(await store.repo.upstreams.getById(victim.id)).not.toBeNull()
    expect(store.deletedGithub).toHaveLength(0)
    expect((await store.repo.upstreams.getById(victim.id))?.name).toBe(victim.name)
  })
}

test('an anonymous caller (no admin, no user) is refused an existing upstream', async () => {
  const victim = copilotUpstream({ ownerId: 'u1' })
  await store.repo.upstreams.save(victim)
  const res = await buildApp({}).request(`/api/upstreams/${victim.id}/models`)
  expect(res.status).toBe(404)
})

// --- sdf config validation -------------------------------------------------
// The taxonomy/CoS enums are fixed at the LLM API side; a typo should fail at
// save time rather than on the first image request.

async function createSdf(config: Record<string, unknown>) {
  return buildApp({ isAdmin: true, userId: 'u1' }).request('/api/upstreams', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'sdf', name: 'img', config }),
  })
}

const BASE_SDF = { name: 'img', substrateToken: 'tok' }

test('POST /api/upstreams accepts a full sdf tuning block', async () => {
  const res = await createSdf({
    ...BASE_SDF,
    taxonomy: { experience: 'BizChat', agent: 'Societas', inferenceStep: 'GenerateResponse', trafficType: 'Production' },
    cos: { serviceTier: 'default' },
    passport: { enabled: true, apiBase: 'https://sdf.passport.microsoft.net' },
  })
  expect(res.status).toBe(201)
  const saved = [...store.upstreams.values()][0]
  const cfg = saved?.config as any
  expect(cfg.taxonomy.agent).toBe('Societas')
  expect(cfg.cos.serviceTier).toBe('default')
  expect(cfg.passport.apiBase).toBe('https://sdf.passport.microsoft.net')
})

test('POST /api/upstreams omits empty sdf sub-objects rather than persisting {}', async () => {
  const res = await createSdf({ ...BASE_SDF, taxonomy: {}, cos: {}, passport: {} })
  expect(res.status).toBe(201)
  const cfg = [...store.upstreams.values()][0]?.config as any
  expect(cfg.taxonomy).toBeUndefined()
  expect(cfg.cos).toBeUndefined()
  expect(cfg.passport).toBeUndefined()
})

for (const bad of [
  { label: 'experience', config: { taxonomy: { experience: 'Designer' } } },
  { label: 'trafficType', config: { taxonomy: { trafficType: 'Staging' } } },
  { label: 'serviceTier', config: { cos: { serviceTier: 'Standard' } } },
  { label: 'passport apiBase scheme', config: { passport: { apiBase: 'http://passport.microsoft.net' } } },
]) {
  test(`POST /api/upstreams rejects an invalid sdf ${bad.label}`, async () => {
    const res = await createSdf({ ...BASE_SDF, ...bad.config })
    expect(res.status).toBe(400)
    expect(store.upstreams.size).toBe(0)
  })
}

test('POST /api/upstreams custom with pathOverrides + authStyle → 201', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      name: 'deepseek',
      config: {
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-secret',
        authStyle: 'anthropic',
        endpoints: ['chat_completions', 'messages'],
        pathOverrides: { messages: '/anthropic/v1/messages' },
      },
    }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(201)
  const body = await res.json() as any
  expect(body.upstream.config.authStyle).toBe('anthropic')
  // pathOverrides is not secret-shaped, so it round-trips unredacted for the form
  expect(body.upstream.config.pathOverrides).toEqual({ messages: '/anthropic/v1/messages' })
  expect(body.upstream.config.apiKey).toBe('***')
})

test('POST /api/upstreams custom with a traversal path override → 400', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      name: 'evil',
      config: {
        name: 'evil',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-1',
        pathOverrides: { messages: '/../../admin' },
      },
    }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
  const body = await res.json() as any
  expect(body.error).toMatch(/must not contain/)
})

test('PATCH /api/upstreams/:id clears pathOverrides with an empty object', async () => {
  const created = await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      name: 'ds',
      config: {
        name: 'ds',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-1',
        pathOverrides: { messages: '/anthropic/v1/messages' },
      },
    }),
    headers: { 'content-type': 'application/json' },
  })
  const id = ((await created.json()) as any).upstream.id

  const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ config: { pathOverrides: {} } }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.upstream.config.pathOverrides).toBeUndefined()
  // the shallow merge preserved everything the PATCH did not mention
  expect(body.upstream.config.baseUrl).toBe('https://api.deepseek.com/v1')
})

// ─────────────────────────────────────────────────────────────────────────────
// proxyFallbackList round-trip
// ─────────────────────────────────────────────────────────────────────────────

const customConfig = { name: 'x', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' }

test('POST /api/upstreams persists proxyFallbackList, deduping ids and uppercasing colos', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      name: 'with-chain',
      config: customConfig,
      proxyFallbackList: [
        { id: 'p1', colos: ['hkg'] },
        { id: 'p1', colos: ['lax'] },
        { id: 'direct_connect' },
      ],
    }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(201)
  const body = await res.json() as any
  expect(body.upstream.proxyFallbackList).toEqual([
    { id: 'p1', colos: ['HKG'] },
    { id: 'direct_connect' },
  ])
  const stored = await store.repo.upstreams.getById(body.upstream.id)
  expect(stored?.proxyFallbackList).toEqual([{ id: 'p1', colos: ['HKG'] }, { id: 'direct_connect' }])
})

test('POST /api/upstreams without proxyFallbackList defaults to []', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({ provider: 'custom', name: 'no-chain', config: customConfig }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(201)
  const body = await res.json() as any
  expect(body.upstream.proxyFallbackList).toEqual([])
})

test('PATCH with only proxyFallbackList replaces the chain and leaves name alone', async () => {
  const created = await (await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({ provider: 'custom', name: 'keepme', config: customConfig }),
    headers: { 'content-type': 'application/json' },
  })).json() as any

  const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${created.upstream.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ proxyFallbackList: [{ id: 'p9' }] }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.upstream.proxyFallbackList).toEqual([{ id: 'p9' }])
  expect(body.upstream.name).toBe('keepme')
})

test('PATCH without proxyFallbackList preserves the existing chain', async () => {
  const created = await (await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      name: 'keep-chain',
      config: customConfig,
      proxyFallbackList: [{ id: 'p1' }],
    }),
    headers: { 'content-type': 'application/json' },
  })).json() as any

  const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${created.upstream.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'renamed' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.upstream.proxyFallbackList).toEqual([{ id: 'p1' }])
  expect(body.upstream.name).toBe('renamed')
})

test('PATCH with an empty proxyFallbackList clears the chain', async () => {
  const created = await (await buildApp({ isAdmin: true }).request('/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      name: 'clear-chain',
      config: customConfig,
      proxyFallbackList: [{ id: 'p1' }],
    }),
    headers: { 'content-type': 'application/json' },
  })).json() as any

  const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${created.upstream.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ proxyFallbackList: [] }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.upstream.proxyFallbackList).toEqual([])
})
