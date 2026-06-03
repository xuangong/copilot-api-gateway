/**
 * GitHub OAuth router tests — Week 5b.
 *
 * Covers /github, /github/poll, /me, DELETE /github/:id, /github/switch
 * ported from old src/routes/auth/github.ts. Uses in-memory repo + fetcher
 * override seam (no mock.module — see bun_mock_module_unrestorable memory).
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { setRepoForTest } from '../src/shared/repo/index.ts'
import type {
  GitHubAccount, Repo, UpstreamRecord,
} from '../src/shared/repo/types.ts'
import { authRouter, type AuthCtx } from '../src/control-plane/auth/routes.ts'
import { setOAuthFetcherForTest } from '../src/control-plane/auth/github-routes.ts'
import { copilotUpstreamRowId } from '../src/shared/lib/github.ts'

interface GhStore {
  accountsByOwner: Map<string, Map<number, GitHubAccount>>
  activeByOwner: Map<string, number>
  globalActive: { id: number | null }
}

function inMemoryRepo() {
  const gh: GhStore = {
    accountsByOwner: new Map(),
    activeByOwner: new Map(),
    globalActive: { id: null },
  }
  const upstreams = new Map<string, UpstreamRecord>()

  function ownerKey(ownerId?: string) {
    return ownerId ?? ''
  }
  function bucket(ownerId?: string) {
    const k = ownerKey(ownerId)
    let b = gh.accountsByOwner.get(k)
    if (!b) { b = new Map(); gh.accountsByOwner.set(k, b) }
    return b
  }

  const repo = {
    users: {
      create: async () => { }, getById: async () => null, findByKey: async () => null,
      findByEmail: async () => null, list: async () => [], update: async () => { }, delete: async () => { },
    },
    sessions: {
      create: async () => { }, findByToken: async () => null,
      deleteByUserId: async () => { }, deleteExpired: async () => { },
    },
    inviteCodes: {
      create: async () => { }, findByCode: async () => null, list: async () => [],
      markUsed: async () => { }, clearUsedBy: async () => { }, delete: async () => { },
    },
    apiKeys: {
      list: async () => [], listByOwner: async () => [], findByRawKey: async () => null,
      getById: async () => null, save: async () => { }, delete: async () => { }, deleteAll: async () => { },
    },
    github: {
      listAccounts: async () => {
        const all: GitHubAccount[] = []
        for (const b of gh.accountsByOwner.values()) all.push(...b.values())
        return all
      },
      listAccountsByOwner: async (ownerId: string) =>
        [...bucket(ownerId).values()],
      getAccount: async (userId: number, ownerId?: string) =>
        bucket(ownerId).get(userId) ?? null,
      saveAccount: async (userId: number, account: GitHubAccount) => {
        bucket(account.ownerId).set(userId, account)
      },
      deleteAccount: async (userId: number, ownerId?: string) => {
        bucket(ownerId).delete(userId)
      },
      deleteAllAccounts: async () => { gh.accountsByOwner.clear() },
      getActiveId: async () => gh.globalActive.id,
      setActiveId: async (id: number) => { gh.globalActive.id = id },
      clearActiveId: async () => { gh.globalActive.id = null },
      getActiveIdForUser: async (ownerId: string) =>
        gh.activeByOwner.get(ownerId) ?? null,
      setActiveIdForUser: async (ownerId: string, id: number) => {
        gh.activeByOwner.set(ownerId, id)
      },
      clearActiveIdForUser: async (ownerId: string) => {
        gh.activeByOwner.delete(ownerId)
      },
    },
    upstreams: {
      list: async () => [...upstreams.values()],
      getById: async (id: string) => upstreams.get(id) ?? null,
      save: async (u: UpstreamRecord) => { upstreams.set(u.id, u) },
      delete: async (id: string) => upstreams.delete(id),
      deleteAll: async () => { upstreams.clear() },
    },
    keyAssignments: {
      assign: async () => { }, unassign: async () => { }, listByUser: async () => [],
      listByKey: async () => [], deleteByKey: async () => { }, deleteByUser: async () => { },
    },
    observabilityShares: {
      share: async () => { }, unshare: async () => { }, listByOwner: async () => [],
      listByViewer: async () => [], isGranted: async () => false,
      deleteByOwner: async () => { }, deleteByViewer: async () => { },
    },
  } as unknown as Repo

  return { repo, gh, upstreams }
}

function buildApp(auth?: AuthCtx) {
  const app = new Hono()
  if (auth) app.use('*', (c, next) => { c.set('auth', auth); return next() })
  app.route('/auth', authRouter)
  return app
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
}

const J = { 'content-type': 'application/json' }

let store: ReturnType<typeof inMemoryRepo>
const originalFetch = globalThis.fetch

beforeEach(() => {
  store = inMemoryRepo()
  setRepoForTest(store.repo)
  // detectAccountType uses raw fetch; stub it to avoid real network.
  globalThis.fetch = (async () => jsonResp({ copilot_plan: 'individual' })) as typeof fetch
})

afterEach(() => {
  setOAuthFetcherForTest(null)
  globalThis.fetch = originalFetch
})

// --- GET /github ---

test('GET /github returns device code payload', async () => {
  setOAuthFetcherForTest(async () => jsonResp({
    device_code: 'dev123', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device',
    expires_in: 900, interval: 5,
  }))
  const res = await buildApp().request('/auth/github')
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.device_code).toBe('dev123')
  expect(body.user_code).toBe('ABCD-EFGH')
})

test('GET /github upstream error → 502', async () => {
  setOAuthFetcherForTest(async () => new Response('boom', { status: 500 }))
  const res = await buildApp().request('/auth/github')
  expect(res.status).toBe(502)
})

// --- POST /github/poll ---

test('POST /github/poll missing device_code → 400', async () => {
  const res = await buildApp().request('/auth/github/poll', {
    method: 'POST', body: '{}', headers: J,
  })
  expect(res.status).toBe(400)
})

test('POST /github/poll authorization_pending', async () => {
  setOAuthFetcherForTest(async () => jsonResp({ error: 'authorization_pending' }))
  const res = await buildApp().request('/auth/github/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'd1' }), headers: J,
  })
  expect(await res.json()).toEqual({ status: 'pending' })
})

test('POST /github/poll slow_down returns interval', async () => {
  setOAuthFetcherForTest(async () => jsonResp({ error: 'slow_down', interval: 10 }))
  const res = await buildApp().request('/auth/github/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'd1' }), headers: J,
  })
  expect(await res.json()).toEqual({ status: 'slow_down', interval: 10 })
})

test('POST /github/poll error returns 400', async () => {
  setOAuthFetcherForTest(async () => jsonResp({
    error: 'access_denied', error_description: 'user said no',
  }))
  const res = await buildApp().request('/auth/github/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'd1' }), headers: J,
  })
  expect(res.status).toBe(400)
  const body = await res.json() as any
  expect(body.status).toBe('error')
  expect(body.error).toBe('user said no')
})

test('POST /github/poll complete saves account + mirrors upstream', async () => {
  let call = 0
  setOAuthFetcherForTest(async (input) => {
    call += 1
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/oauth/access_token')) {
      return jsonResp({ access_token: 'gho_abc' })
    }
    if (url.includes('/user')) {
      return jsonResp({
        id: 42, login: 'octo', name: 'Octo Cat',
        avatar_url: 'https://avatars/octo.png',
      })
    }
    if (url.includes('/copilot_internal/v2/token')) {
      return jsonResp({ token: 'tok' })
    }
    return jsonResp({}, 404)
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'd1' }), headers: J,
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.status).toBe('complete')
  expect(body.user.login).toBe('octo')
  expect(call).toBeGreaterThanOrEqual(2)

  // saved into per-owner bucket
  const acct = store.gh.accountsByOwner.get('u1')?.get(42)
  expect(acct?.token).toBe('gho_abc')
  expect(acct?.user.login).toBe('octo')
  expect(store.gh.activeByOwner.get('u1')).toBe(42)

  // mirrored into upstreams
  const upId = copilotUpstreamRowId('u1', 42)
  const up = store.upstreams.get(upId)
  expect(up).toBeDefined()
  expect(up?.provider).toBe('copilot')
  expect(up?.name).toBe('octo')
})

// --- GET /me ---

test('GET /me admin sees github_connected=true when any account exists', async () => {
  await store.repo.github.saveAccount(99, {
    token: 't', accountType: 'individual',
    user: { id: 99, login: 'g', name: null, avatar_url: '' },
    ownerId: 'other',
  })
  const res = await buildApp({ isAdmin: true, userId: 'admin' })
    .request('/auth/me')
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.github_connected).toBe(true)
  expect(body.authenticated).toBe(true)
})

test('GET /me user sees github_connected=false when no own accounts', async () => {
  await store.repo.github.saveAccount(99, {
    token: 't', accountType: 'individual',
    user: { id: 99, login: 'g', name: null, avatar_url: '' },
    ownerId: 'other',
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/me')
  const body = await res.json() as any
  expect(body.github_connected).toBe(false)
})

test('GET /me user sees github_connected=true when own account exists', async () => {
  await store.repo.github.saveAccount(7, {
    token: 't', accountType: 'individual',
    user: { id: 7, login: 'me', name: null, avatar_url: '' },
    ownerId: 'u1',
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/me')
  const body = await res.json() as any
  expect(body.github_connected).toBe(true)
})

// --- DELETE /github/:id ---

test('DELETE /github/:id invalid id → 400', async () => {
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/abc', {
    method: 'DELETE',
  })
  expect(res.status).toBe(400)
})

test('DELETE /github/:id removes account', async () => {
  await store.repo.github.saveAccount(42, {
    token: 't', accountType: 'individual',
    user: { id: 42, login: 'me', name: null, avatar_url: '' },
    ownerId: 'u1',
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/42', {
    method: 'DELETE',
  })
  expect(res.status).toBe(200)
  expect(store.gh.accountsByOwner.get('u1')?.has(42)).toBe(false)
})

// --- POST /github/switch ---

test('POST /github/switch missing user_id → 400', async () => {
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/switch', {
    method: 'POST', body: '{}', headers: J,
  })
  expect(res.status).toBe(400)
})

test('POST /github/switch not found → 404', async () => {
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/switch', {
    method: 'POST', body: JSON.stringify({ user_id: 999 }), headers: J,
  })
  expect(res.status).toBe(404)
})

test('POST /github/switch sets active id', async () => {
  await store.repo.github.saveAccount(7, {
    token: 't', accountType: 'individual',
    user: { id: 7, login: 'me', name: null, avatar_url: '' },
    ownerId: 'u1',
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/switch', {
    method: 'POST', body: JSON.stringify({ user_id: 7 }), headers: J,
  })
  expect(res.status).toBe(200)
  expect(store.gh.activeByOwner.get('u1')).toBe(7)
})
