/**
 * copilot-quota control-plane tests — Week 5b.
 *
 * Per bun_mock_module_unrestorable: use setRepoForTest + globalThis.fetch
 * stub (no mock.module). Mirrors the github-accounts test wiring.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { __resetPlatformForTests } from '@vibe-core/platform'
import type { GitHubAccount, UpstreamRecord } from '../src/repo/types.ts'
import type { GitHubAccountId, UserId } from '../src/repo/branded-ids.ts'
import { setupTestPlatform } from './_setup-platform.ts'
import {
  copilotQuotaRouter,
  type CopilotQuotaAuthCtx,
} from '../src/control-plane/copilot-quota/routes.ts'

// The real repo over in-memory SQLite (setupTestPlatform), not a hand-written
// fake: a fake drifts from the Repo contract, e.g. ignoring the owner in
// getAccount's (user_id, owner_id) key.
function testStore() {
  return setupTestPlatform()
}

function buildApp(auth: CopilotQuotaAuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api', copilotQuotaRouter)
  return app
}

function ghAccount(userId: number, ownerId: string, token = 'gh_token'): GitHubAccount {
  return {
    token,
    accountType: 'individual',
    user: { id: userId, login: 'alice', name: 'Alice', avatar_url: '' },
    ownerId,
    enabled: true,
    sortOrder: 0,
  } as GitHubAccount
}

let store: ReturnType<typeof testStore>
let originalFetch: typeof fetch

beforeEach(() => {
  // initRepo and initRuntimeLocation both write process-global state that Bun
  // carries across test files in one process; reset first so this file neither
  // inherits nor leaks a platform singleton. The relay resolves an egress
  // fetcher, which reads the runtime location, so set one for every test.
  store = testStore()
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === 'https://api.github.com/copilot_internal/user') {
      return new Response(JSON.stringify({ remaining: 999, quota_snapshots: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

test('GET /api/copilot-quota unauthenticated → 401', async () => {
  const res = await buildApp({}).request('/api/copilot-quota')
  expect(res.status).toBe(401)
})

test('GET /api/copilot-quota with no connected account → 502', async () => {
  const res = await buildApp({ userId: 'u1' }).request('/api/copilot-quota')
  expect(res.status).toBe(502)
})

test('GET /api/copilot-quota returns quota for active account', async () => {
  await store.repo.github.saveAccount(1, ghAccount(1, 'u1'))
  await store.repo.github.setActiveIdForUser('u1' as UserId, 1 as GitHubAccountId)
  const res = await buildApp({ userId: 'u1' }).request('/api/copilot-quota')
  expect(res.status).toBe(200)
  const body = await res.json() as { remaining: number }
  expect(body.remaining).toBe(999)
})

test('effectiveUserId overrides userId (shared-view target)', async () => {
  await store.repo.github.saveAccount(5, ghAccount(5, 'owner'))
  await store.repo.github.setActiveIdForUser('owner' as UserId, 5 as GitHubAccountId)
  const res = await buildApp({ userId: 'viewer', effectiveUserId: 'owner' })
    .request('/api/copilot-quota')
  expect(res.status).toBe(200)
})

test('GET /api/copilot-quota propagates GitHub error status', async () => {
  await store.repo.github.saveAccount(1, ghAccount(1, 'u1'))
  await store.repo.github.setActiveIdForUser('u1' as UserId, 1 as GitHubAccountId)
  globalThis.fetch = (async () =>
    new Response('forbidden', { status: 403 })) as unknown as typeof fetch
  const res = await buildApp({ userId: 'u1' }).request('/api/copilot-quota')
  expect(res.status).toBe(403)
  const body = await res.json() as { error: string }
  expect(body.error).toMatch(/GitHub API error: 403/)
})

test('GET /api/admin/copilot-quota/:id requires admin', async () => {
  const res = await buildApp({ userId: 'u1' }).request('/api/admin/copilot-quota/1')
  expect(res.status).toBe(403)
})

test('GET /api/admin/copilot-quota/:id returns 404 when account missing', async () => {
  const res = await buildApp({ userId: 'admin', isAdmin: true })
    .request('/api/admin/copilot-quota/999')
  expect(res.status).toBe(404)
})

test('GET /api/admin/copilot-quota/:id returns quota for any account', async () => {
  await store.repo.github.saveAccount(7, ghAccount(7, 'u2'))
  const res = await buildApp({ userId: 'admin' as UserId, isAdmin: true })
    .request('/api/admin/copilot-quota/7')
  expect(res.status).toBe(200)
  const body = await res.json() as { remaining: number }
  expect(body.remaining).toBe(999)
})

test('GET /api/copilot-quota with an unresolvable chain → 502 naming the proxy id', async () => {
  const now = new Date().toISOString()
  const chained: UpstreamRecord = {
    id: 'up_copilot_u1_42',
    provider: 'copilot',
    name: 'chained',
    enabled: true,
    sortOrder: 0,
    config: {},
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
    createdAt: now,
    updatedAt: now,
    proxyFallbackList: [{ id: 'px_gone' }],
  }

  // A stored row whose chain names a proxy id the (empty) proxies table
  // cannot resolve.
  await store.repo.upstreams.save(chained)

  await store.repo.github.saveAccount(42, ghAccount(42, 'u1'))
  await store.repo.github.setActiveIdForUser('u1' as UserId, 42 as GitHubAccountId)

  const res = await buildApp({ userId: 'u1' as UserId }).request('/api/copilot-quota')
  expect(res.status).toBe(502)
  const body = (await res.json()) as { error: string }
  expect(body.error).toContain('px_gone')
})

/**
 * The admin route resolves the chain of the *account's* owner, not the
 * caller's. The chained row below is keyed `up_copilot_u2_7` — what
 * `copilotUpstreamRowId(account.ownerId, 7)` builds — so reaching it proves the
 * ownerId was carried through.
 *
 * Verified by mutation: dropping `account.ownerId ?? ''` to a bare `''` builds
 * `up_copilot_global_7`, which is not stored, and the route then
 * relays over the ambient fetch and 200s. Every other admin case in this file
 * survives that mutation, because none of them stores a chained row.
 */
test('GET /api/admin/copilot-quota/:id resolves the chain of the account owner', async () => {
  const now = new Date().toISOString()
  const chained: UpstreamRecord = {
    id: 'up_copilot_u2_7',
    provider: 'copilot',
    name: 'chained',
    enabled: true,
    sortOrder: 0,
    config: {},
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
    createdAt: now,
    updatedAt: now,
    proxyFallbackList: [{ id: 'px_gone' }],
  }

  await store.repo.upstreams.save(chained)

  await store.repo.github.saveAccount(7, ghAccount(7, 'u2'))

  const res = await buildApp({ userId: 'admin' as UserId, isAdmin: true })
    .request('/api/admin/copilot-quota/7')
  expect(res.status).toBe(502)
  const body = (await res.json()) as { error: string }
  expect(body.error).toContain('px_gone')
})

// A GHE.com tenant account must be queried on its own REST host
// (api.SUBDOMAIN.ghe.com); sending its tenant token to api.github.com can
// only fail, and leaks the token to the wrong GitHub instance.
test('quota for a ghe.com account is fetched from the tenant API, for the user and admin routes', async () => {
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    urls.push(url)
    if (url === 'https://api.acme.ghe.com/copilot_internal/user') {
      return new Response(JSON.stringify({ remaining: 7 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  await store.repo.github.saveAccount(9, { ...ghAccount(9, 'u1'), githubHost: 'acme.ghe.com' })
  await store.repo.github.setActiveIdForUser('u1' as UserId, 9 as GitHubAccountId)

  const own = await buildApp({ userId: 'u1' }).request('/api/copilot-quota')
  expect(own.status).toBe(200)
  expect(((await own.json()) as { remaining: number }).remaining).toBe(7)
  const admin = await buildApp({ isAdmin: true, userId: 'admin' }).request('/api/admin/copilot-quota/9')
  expect(admin.status).toBe(200)
  expect(urls).toEqual(['https://api.acme.ghe.com/copilot_internal/user', 'https://api.acme.ghe.com/copilot_internal/user'])
})
