/**
 * Control-plane github-accounts (mounted at /api/upstream-accounts) tests
 * — Week 5a-impl.
 *
 * Covers the single endpoint ported from old src/routes/upstream-accounts.ts.
 * Uses an in-memory Repo + a fetch shim for the api.github.com calls
 * (/user, /copilot_internal/user). The shim is installed in beforeEach and
 * restored in afterEach.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { __resetPlatformForTests, initSocketDial } from '@vibe-core/platform'
import type { GitHubAccount, UpstreamRecord } from '../src/repo/types.ts'
import type { UserId } from '../src/repo/branded-ids.ts'
import type { ProxyRecord } from '@vibe-core/proxy-repo'
import { setupTestPlatform } from './_setup-platform.ts'
import {
  githubAccountsRouter,
  type ViewCtx,
} from '../src/control-plane/github-accounts/routes.ts'

// The real repo over in-memory SQLite (setupTestPlatform) rather than a
// hand-written fake, so upstream rows, proxies and dial backoffs behave as in
// production.
function testStore() {
  return setupTestPlatform()
}

function buildApp(auth: ViewCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api/upstream-accounts', githubAccountsRouter)
  return app
}

function ghAccount(over: Partial<GitHubAccount> & { userId?: number } = {}): GitHubAccount {
  const userId = over.userId ?? 42
  return {
    token: 'gh_token_secret',
    accountType: 'individual',
    user: { id: userId, login: 'alice', name: 'Alice', avatar_url: '' },
    ownerId: over.ownerId,
    enabled: true,
    sortOrder: 0,
    ...over,
  } as GitHubAccount
}

let store: ReturnType<typeof testStore>
let originalFetch: typeof fetch

beforeEach(() => {
  // initRepo and initRuntimeLocation both write process-global state that Bun
  // carries across test files in one process; reset first so this file neither
  // inherits nor leaks a platform singleton. The enrichment loop resolves an
  // egress fetcher, which reads the runtime location, so set one for every test.
  store = testStore()
  originalFetch = globalThis.fetch
  // Shim: /user → 200 (token valid), /copilot_internal/user → quota json
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/copilot_internal/user')) {
      return new Response(JSON.stringify({ remaining: 1234 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api.github.com/user') {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

test('GET /api/upstream-accounts unauthenticated → 401', async () => {
  const res = await buildApp({}).request('/api/upstream-accounts')
  expect(res.status).toBe(401)
})

test('non-admin sees only own owner accounts', async () => {
  await store.repo.github.saveAccount(1, ghAccount({ userId: 1, ownerId: 'u1' }))
  await store.repo.github.saveAccount(2, ghAccount({ userId: 2, ownerId: 'u2' }))
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/upstream-accounts')
  expect(res.status).toBe(200)
  const body = await res.json() as any[]
  expect(body).toHaveLength(1)
  expect(body[0].id).toBe('1')
  expect(body[0].token_valid).toBe(true)
  expect(body[0].quota).toEqual({ remaining: 1234 })
  // Never leak token
  expect(JSON.stringify(body[0])).not.toContain('gh_token_secret')
})

test('admin self-view sees ALL accounts', async () => {
  await store.repo.github.saveAccount(1, ghAccount({ userId: 1, ownerId: 'u1' }))
  await store.repo.github.saveAccount(2, ghAccount({ userId: 2, ownerId: 'u2' }))
  const res = await buildApp({ authKind: 'session', userId: 'admin', isAdmin: true }).request('/api/upstream-accounts')
  const body = await res.json() as any[]
  expect(body).toHaveLength(2)
  // Cross-user accounts get owner_id annotation in adminGlobalView
  expect(body.find((b) => b.id === '1').owner_id).toBe('u1')
})

test('active flag reflects activeIdForUser for non-admin', async () => {
  await store.repo.github.saveAccount(1, ghAccount({ userId: 1, ownerId: 'u1' }))
  await store.repo.github.saveAccount(2, ghAccount({ userId: 2, ownerId: 'u1' }))
  await store.repo.github.setActiveIdForUser('u1' as UserId, 2 as GitHubAccountId)
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/upstream-accounts')
  const body = await res.json() as any[]
  const a1 = body.find((b) => b.id === '1')
  const a2 = body.find((b) => b.id === '2')
  expect(a1.active).toBe(false)
  expect(a2.active).toBe(true)
})

test('avatar_url falls back to githubusercontent template', async () => {
  await store.repo.github.saveAccount(7, ghAccount({ userId: 7, ownerId: 'u1' }))
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/upstream-accounts')
  const body = await res.json() as any[]
  expect(body[0].avatar_url).toBe('https://avatars.githubusercontent.com/u/7?v=4')
})

test('effectiveUserId overrides userId (shared-view target)', async () => {
  await store.repo.github.saveAccount(1, ghAccount({ userId: 1, ownerId: 'owner' }))
  const res = await buildApp({
    authKind: 'session', userId: 'viewer', effectiveUserId: 'owner', isViewingShared: true, ownerId: 'owner',
  }).request('/api/upstream-accounts')
  const body = await res.json() as any[]
  expect(body).toHaveLength(1)
  expect(body[0].id).toBe('1')
})

test('token_valid is false when GitHub returns 401', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === 'https://api.github.com/user') return new Response('unauth', { status: 401 })
    return new Response('null', { status: 404 })
  }) as unknown as typeof fetch
  await store.repo.github.saveAccount(1, ghAccount({ userId: 1, ownerId: 'u1' }))
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/upstream-accounts')
  const body = await res.json() as any[]
  expect(body[0].token_valid).toBe(false)
  expect(body[0].quota).toBeNull()
})

test('GET / with an unresolvable chain → 502, not token_valid:false', async () => {
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

  await store.repo.github.saveAccount(42, ghAccount({ userId: 42, ownerId: 'u1' as UserId }))

  const res = await buildApp({ authKind: 'session', userId: 'u1' as UserId })
    .request('/api/upstream-accounts')
  expect(res.status).toBe(502)
  const body = (await res.json()) as { error: string }
  expect(body.error).toContain('px_gone')
})

/**
 * Mirrored Copilot upstream row for the account saved as user 42 / owner u1.
 * `copilotUpstreamRowId` (control-plane/lib/github.ts) builds that id as
 * `up_copilot_<ownerId>_<githubUserId>`, so the route's lookup only hits this
 * row when the id below matches exactly.
 */
function copilotRow(chain: UpstreamRecord['proxyFallbackList']): UpstreamRecord {
  const now = new Date().toISOString()
  return {
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
    proxyFallbackList: chain,
  }
}

/** Stores `row` and `proxies`; the route then resolves the chain from the real tables. */
async function useChainedRow(row: UpstreamRecord, proxies: ProxyRecord[]) {
  await store.repo.upstreams.save(row)
  for (const proxy of proxies) await store.repo.proxies.save(proxy)
}

/**
 * The enrichment calls must travel through the fetcher `accountFetcher` builds
 * from the row's chain, not through the ambient global `fetch`.
 *
 * The oracle is a chain naming one real, resolvable proxy whose transport is a
 * SocketDial stub that refuses every connection. Both outcomes below are only
 * reachable through the resolved fetcher:
 *   - `dials` is non-empty — nothing else in this route opens a socket; the
 *     global `fetch` here is the beforeEach shim, which returns Responses
 *     without dialling.
 *   - `token_valid` is false and `quota` is null — that shim answers 200 for
 *     both api.github.com URLs the route requests, so a call that reached it
 *     would report a live token.
 * Replacing either `await doFetch(` in github-accounts/routes.ts with
 * `await fetch(` therefore fails this test; each of the two assertions detects
 * that mutation on its own (checked separately, one at a time).
 *
 * No packet leaves the process: the stub throws instead of connecting, so the
 * proxy address below is never contacted and the test does not depend on
 * 127.0.0.1:1 being closed.
 */
test('a saved chain sends the enrichment calls through the resolved fetcher', async () => {
  const dials: Array<{ host: string; port: number }> = []
  // The dialer obtains this via `getSocketDial()` at attempt time; the platform
  // reset in afterEach clears it again. `connectOrDialError`
  // (packages/proxy/src/dial-target.ts, reached here from
  // protocols/http-connect.ts) turns this throw into a ProxyDialError, which
  // the fetcher treats as a failed entry — and with a one-entry chain it
  // rethrows that single error rather than an AggregateError.
  initSocketDial({
    connect: async (host: string, port: number) => {
      dials.push({ host, port })
      throw new Error('refused by test SocketDial')
    },
  })

  const now = new Date().toISOString()
  await useChainedRow(copilotRow([{ id: 'px_local' }]), [
    {
      id: 'px_local',
      name: 'local',
      url: 'http://127.0.0.1:1',
      createdAt: now,
      updatedAt: now,
      dialTimeoutSeconds: null,
    },
  ])

  await store.repo.github.saveAccount(42, ghAccount({ userId: 42, ownerId: 'u1' as UserId }))

  const res = await buildApp({ authKind: 'session', userId: 'u1' as UserId })
    .request('/api/upstream-accounts')
  // A resolvable chain whose dial fails is swallowed per-account by the two
  // helpers' catches, so the list still answers 200 — only the 502 path above
  // (chain that cannot resolve at all) fails the whole request.
  expect(res.status).toBe(200)
  const body = (await res.json()) as Array<{ token_valid: boolean; quota: unknown }>
  expect(body).toHaveLength(1)
  expect(body[0]!.token_valid).toBe(false)
  expect(body[0]!.quota).toBeNull()

  // Both helpers dial, and the address is the proxy's rather than
  // api.github.com's — the upstream is only reachable through that connection.
  expect(dials.length).toBeGreaterThan(0)
  for (const d of dials) expect(d).toEqual({ host: '127.0.0.1', port: 1 })
})

/**
 * The other half of `accountFetcher`'s contract: a row with no chain keeps the
 * global `fetch`. `resolveControlPlaneFetcher` returns undefined for an empty
 * override list and the route falls back with `?? fetch`.
 *
 * This case does NOT discriminate `doFetch` from `fetch` — with no chain the
 * two are the same function. What it pins is that the empty chain resolves to
 * the ambient fetch and to no socket at all: making an empty list collapse to a
 * built-in transport (as packages/dial/src/fetcher.ts does for its own empty
 * `fallbackList`) would dial through the refusing stub and flip both
 * assertions. Verified by mutation: returning `[{ id: 'direct_connect' }]`
 * instead of `undefined` from that empty-list branch fails this test.
 */
test('a row without a chain keeps the global fetch (no dial)', async () => {
  const dials: Array<{ host: string; port: number }> = []
  initSocketDial({
    connect: async (host: string, port: number) => {
      dials.push({ host, port })
      throw new Error('refused by test SocketDial')
    },
  })

  await useChainedRow(copilotRow([]), [])
  await store.repo.github.saveAccount(42, ghAccount({ userId: 42, ownerId: 'u1' as UserId }))

  const res = await buildApp({ authKind: 'session', userId: 'u1' as UserId })
    .request('/api/upstream-accounts')
  expect(res.status).toBe(200)
  const body = (await res.json()) as Array<{ token_valid: boolean; quota: unknown }>
  expect(body[0]!.token_valid).toBe(true)
  expect(body[0]!.quota).toEqual({ remaining: 1234 })
  expect(dials).toHaveLength(0)
})

// A GHE.com tenant account is validated and enriched on its own REST host;
// asking api.github.com would report a perfectly good tenant token as invalid.
test('a ghe.com account is validated and enriched against the tenant API', async () => {
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    urls.push(url)
    if (url === 'https://api.acme.ghe.com/copilot_internal/user') {
      return new Response(JSON.stringify({ remaining: 5 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === 'https://api.acme.ghe.com/user') return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  await store.repo.github.saveAccount(9, ghAccount({ userId: 9, ownerId: 'u1' as UserId, githubHost: 'acme.ghe.com' }))
  const res = await buildApp({ userId: 'u1' as UserId }).request('/api/upstream-accounts')
  expect(res.status).toBe(200)
  const [row] = (await res.json()) as Array<{ token_valid: boolean; quota: { remaining: number } }>
  expect(row).toMatchObject({ token_valid: true, quota: { remaining: 5 } })
  expect(urls.sort()).toEqual(['https://api.acme.ghe.com/copilot_internal/user', 'https://api.acme.ghe.com/user'])
})
