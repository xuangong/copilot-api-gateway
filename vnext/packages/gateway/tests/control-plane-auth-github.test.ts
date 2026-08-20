/**
 * GitHub OAuth router tests — Week 5b.
 *
 * Covers /github, /github/poll, /github/paste-token, /me, DELETE /github/:id,
 * /github/switch ported from old src/routes/auth/github.ts, plus the auth
 * guard on the two device-flow routes. Most cases use an in-memory repo; the
 * seven that submit a proxy chain use a real BunSqliteRepo, so the proxies
 * table exists and chains round-trip the real column plumbing (see
 * `realRepo`). Every case stubs `globalThis.fetch`
 * for every outbound call (no mock.module — see
 * bun_mock_module_unrestorable memory).
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/repo/index.ts'
import { __resetPlatformForTests, initRuntimeLocation } from '@vibe-core/platform'
import type {
  GitHubAccount, Repo, UpstreamRecord,
} from '../src/repo/types.ts'
import { authRouter, type AuthCtx } from '../src/control-plane/auth/routes.ts'
import { copilotUpstreamRowId } from '../src/control-plane/lib/github.ts'
import { realFetch, stubGlobalFetch } from './_stub-global-fetch.ts'

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

beforeEach(() => {
  // initRuntimeLocation writes process-global state that Bun carries across
  // test files in one process; reset first so this file neither inherits nor
  // leaks a platform singleton. The reset has to run before the init below,
  // or it would clear what we just set.
  __resetPlatformForTests()
  store = inMemoryRepo()
  initRepo(store.repo)
  // resolveControlPlaneFetcher reads the runtime location, which throws until
  // a platform bootstrap has run. Tests have no bootstrap, so set it here.
  initRuntimeLocation('bun')
  // Default stub so no test reaches the real network; individual tests
  // replace it with a stub shaped for the calls they exercise.
  stubGlobalFetch(async () => jsonResp({ copilot_plan: 'individual' }))
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// --- POST /github ---

test('POST /github returns device code payload', async () => {
  stubGlobalFetch(async () => jsonResp({
    device_code: 'dev123', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device',
    expires_in: 900, interval: 5,
  }))
  const res = await buildApp({ userId: 'u1' }).request('/auth/github', { method: 'POST' })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.device_code).toBe('dev123')
  expect(body.user_code).toBe('ABCD-EFGH')
})

test('POST /github upstream error → 502', async () => {
  stubGlobalFetch(async () => new Response('boom', { status: 500 }))
  const res = await buildApp({ userId: 'u1' }).request('/auth/github', { method: 'POST' })
  expect(res.status).toBe(502)
})

// --- POST /github/poll ---

test('POST /github/poll missing device_code → 400', async () => {
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST', body: '{}', headers: J,
  })
  expect(res.status).toBe(400)
})

test('POST /github/poll authorization_pending', async () => {
  stubGlobalFetch(async () => jsonResp({ error: 'authorization_pending' }))
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'd1' }), headers: J,
  })
  expect(await res.json()).toEqual({ status: 'pending' })
})

test('POST /github/poll slow_down returns interval', async () => {
  stubGlobalFetch(async () => jsonResp({ error: 'slow_down', interval: 10 }))
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'd1' }), headers: J,
  })
  expect(await res.json()).toEqual({ status: 'slow_down', interval: 10 })
})

test('POST /github/poll error returns 400', async () => {
  stubGlobalFetch(async () => jsonResp({
    error: 'access_denied', error_description: 'user said no',
  }))
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'd1' }), headers: J,
  })
  expect(res.status).toBe(400)
  const body = await res.json() as any
  expect(body.status).toBe('error')
  expect(body.error).toBe('user said no')
})

test('POST /github/poll complete saves account + mirrors upstream', async () => {
  let call = 0
  // The `/user` branch also answers detectAccountType's
  // /copilot_internal/user probe; that payload carries no `copilot_plan`, so
  // detectAccountType falls back to 'individual' — the same account type the
  // previous two-seam setup produced.
  stubGlobalFetch(async (input) => {
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

// --- auth guard on the device-flow routes ---

/*
 * Both guard cases run against the real SqliteRepo (see `realRepo` below), not
 * the in-memory fixture. The fixture has no `proxies` accessor, so resolving
 * any id throws a TypeError before the resolver can report on it: the body
 * comes back "failed to resolve the submitted proxy chain: undefined is not an
 * object (evaluating 'proxies.list')", which never contains the submitted id.
 * The status assertion still discriminates under the fixture — remove the
 * guard and the request 400s instead of 401ing — but the body assertions
 * and the `direct` assertion carry no signal there, because an id that never
 * reaches the resolver can neither be echoed nor dialled. With the real repo
 * the proxies table exists and is empty, so were the guard removed the request
 * would reach the resolver and come back 400 with
 * "unknown proxy id in fallback list: px_missing" — the very oracle the guard
 * closes. That is what the body assertions below discriminate against.
 */

test('POST /github unauthenticated → 401 that does not confirm or deny the proxy id', async () => {
  await realRepo()
  let direct = 0
  stubGlobalFetch(async () => { direct += 1; return jsonResp({}) })
  const res = await buildApp().request('/auth/github', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ proxy_fallback_list: [{ id: 'px_missing' }] }),
  })
  expect(res.status).toBe(401)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toBeTruthy()
  // The oracle assertion: the 401 must not echo the submitted id, so the
  // caller cannot tell an existing proxy id from a missing one.
  expect(body.error).not.toContain('px_missing')
  // Backstop for the guard's other job — no dial through an admin-configured
  // proxy. Weaker than the assertion above, since an unresolvable id would not
  // reach a dial anyway; it holds the line for ids that would resolve.
  expect(direct).toBe(0)
})

test('POST /github/poll unauthenticated → 401 that does not confirm or deny the proxy id', async () => {
  await realRepo()
  let direct = 0
  stubGlobalFetch(async () => { direct += 1; return jsonResp({}) })
  const res = await buildApp().request('/auth/github/poll', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ device_code: 'd1', proxy_fallback_list: [{ id: 'px_missing' }] }),
  })
  expect(res.status).toBe(401)
  const body = (await res.json()) as { status?: string, error?: string }
  expect(body.status).toBe('error')
  expect(body.error).toBeTruthy()
  expect(body.error).not.toContain('px_missing')
  expect(direct).toBe(0)
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

// buildApp() with no argument mounts no auth middleware, which is exactly what
// session-auth.ts does for an unauthenticated caller: it leaves `auth` unset
// rather than setting a userId-less context (session-auth.ts:108).

test('DELETE /github/:id without auth → 401 and the account survives', async () => {
  await store.repo.github.saveAccount(42, {
    token: 't', accountType: 'individual',
    user: { id: 42, login: 'me', name: null, avatar_url: '' },
    ownerId: 'u1',
  })
  const res = await buildApp().request('/auth/github/42', { method: 'DELETE' })
  expect(res.status).toBe(401)
  // Without the guard the undefined ownerId reaches the unscoped DELETE, so
  // asserting the row is still there is what actually pins the fix.
  expect(store.gh.accountsByOwner.get('u1')?.has(42)).toBe(true)
})

test('DELETE /github/:id checks auth before the id shape', async () => {
  // An unauthenticated caller must not learn whether the id parsed.
  const res = await buildApp().request('/auth/github/abc', { method: 'DELETE' })
  expect(res.status).toBe(401)
})

test('POST /github/switch without auth → 401 and no global active id is set', async () => {
  await store.repo.github.saveAccount(7, {
    token: 't', accountType: 'individual',
    user: { id: 7, login: 'me', name: null, avatar_url: '' },
  })
  const res = await buildApp().request('/auth/github/switch', {
    method: 'POST', body: JSON.stringify({ user_id: 7 }), headers: J,
  })
  expect(res.status).toBe(401)
  expect(store.gh.globalActive.id).toBe(null)
})

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

// --- draft proxy chain ---

/** Real SqliteRepo — these cases read the proxies table and the saved row.
 *  The runtime location these cases need is set in `beforeEach`. */
async function realRepo() {
  const { Database } = await import('bun:sqlite')
  const { BunSqliteRepo } = await import('@vibe-llm/platform-bun/src/bun-sqlite-repo.ts')
  const r = new BunSqliteRepo(new Database(':memory:'))
  initRepo(r)
  return r
}

test('POST /github with an unknown proxy id → 400 naming the id but not the url', async () => {
  await realRepo()
  const res = await buildApp({ userId: 'u1' }).request('/auth/github', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ proxy_fallback_list: [{ id: 'px_missing' }] }),
  })
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('px_missing')
  expect(body.error).not.toContain('trojan://')
})

test('POST /github with a malformed proxy → 400 without leaking the url', async () => {
  const r = await realRepo()
  await r.proxies.save({
    id: 'px_bad', name: 'bad', url: 'not-a-proxy-uri', dialTimeoutSeconds: null,
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/github', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ proxy_fallback_list: [{ id: 'px_bad' }] }),
  })
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('px_bad')
  expect(body.error).not.toContain('not-a-proxy-uri')
})

test('POST /github/poll routes all three outbound calls through the resolved fetcher', async () => {
  const r = await realRepo()
  await r.proxies.save({
    id: 'px_ok', name: 'ok', url: 'trojan://pw@node.example.com:443', dialTimeoutSeconds: null,
  })

  // The chain resolves, so the route must NOT reach globalThis.fetch at all.
  // Counting direct-fetch calls is the assertion: 0 means every outbound call
  // went through the proxy fetcher.
  let direct = 0
  stubGlobalFetch(async () => { direct += 1; return jsonResp({}, 500) })

  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ device_code: 'd1', proxy_fallback_list: [{ id: 'px_ok' }] }),
  })

  // The chain resolves, so the first outbound call enters the proxy dial
  // instead of globalThis.fetch. No socket dial is registered here — the file
  // only sets the runtime location — so getSocketDial() throws
  // "SocketDial not initialized" before any connection is attempted, and that
  // exception escapes the handler as a 500. The hostname is never resolved, so
  // it plays no part in the failure. What the case asserts is *where* it
  // failed: a non-2xx plus direct === 0 proves the resolved fetcher was used.
  expect(res.status).toBeGreaterThanOrEqual(400)
  expect(direct).toBe(0)
})

test('POST /github/paste-token rejects an unknown proxy id before touching GitHub', async () => {
  await realRepo()
  let direct = 0
  stubGlobalFetch(async () => { direct += 1; return jsonResp({}) })

  const res = await buildApp({ userId: 'u1' }).request('/auth/github/paste-token', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ github_token: 'gho_x', proxy_fallback_list: [{ id: 'px_missing' }] }),
  })
  expect(res.status).toBe(400)
  expect(direct).toBe(0)
})

test('a successful device-flow login persists the submitted chain', async () => {
  const r = await realRepo()
  stubGlobalFetch(async (input) => {
    const url = String(input)
    if (url.includes('/oauth/access_token')) return jsonResp({ access_token: 'gho_abc' })
    if (url.includes('/copilot_internal')) return jsonResp({ token: 'tok' })
    if (url.includes('/user')) {
      return jsonResp({ id: 42, login: 'octo', name: 'Octo Cat', avatar_url: 'https://a/o.png' })
    }
    return jsonResp({}, 404)
  })

  // An empty chain resolves to `undefined`, so the route keeps globalThis.fetch
  // and the stub above answers — which is what lets this case assert on
  // persistence without needing a reachable proxy.
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ device_code: 'd1', proxy_fallback_list: [] }),
  })
  expect(res.status).toBe(200)

  const row = await r.upstreams.getById('up_copilot_u1_42')
  expect(row?.proxyFallbackList).toEqual([])
})

/**
 * Seeds the mirrored Copilot row a re-login would find, carrying a chain that
 * was edited after the first login. `up_copilot_u1_42` is what
 * `copilotUpstreamRowId('u1', 42)` builds for the GitHub user both re-entry
 * cases below log back in as.
 */
async function seedChainedCopilotRow(r: Awaited<ReturnType<typeof realRepo>>) {
  const now = new Date().toISOString()
  await r.proxies.save({
    id: 'px_keep', name: 'keep', url: 'trojan://pw@node.example.com:443', dialTimeoutSeconds: null,
  })
  await r.upstreams.save({
    id: copilotUpstreamRowId('u1', 42),
    ownerId: 'u1',
    provider: 'copilot',
    name: 'octo',
    enabled: true,
    sortOrder: 0,
    config: {},
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
    proxyFallbackList: [{ id: 'px_keep' }],
    createdAt: now,
    updatedAt: now,
  } as UpstreamRecord)
}

/**
 * The complement of the two "persists the submitted chain" paths: an *absent*
 * `proxy_fallback_list` must reach `addGithubAccount` as `undefined`, which
 * lib/github.ts:79-82 reads as "keep the row's existing chain". Sending `[]`
 * instead would look harmless but silently wipes a chain the user edited after
 * their first login, and on a proxy-only host that turns the account's egress
 * direct. Verified by mutation: `proxyFallbackList: proxy_fallback_list ?? []`
 * at github-routes.ts:211 (device-flow) and :301 (paste) passes every other
 * case in this file and fails only these two.
 *
 * Neither case submits a chain, so `egressFetcher` returns undefined and the
 * route keeps globalThis.fetch — the stub below answers every outbound call,
 * and `px_keep` never has to be dialled.
 */
test('a re-login without a chain keeps the chain already on the row', async () => {
  const r = await realRepo()
  await seedChainedCopilotRow(r)
  stubGlobalFetch(async (input) => {
    const url = String(input)
    if (url.includes('/oauth/access_token')) return jsonResp({ access_token: 'gho_abc' })
    if (url.includes('/copilot_internal')) return jsonResp({ token: 'tok' })
    if (url.includes('/user')) {
      return jsonResp({ id: 42, login: 'octo', name: 'Octo Cat', avatar_url: 'https://a/o.png' })
    }
    return jsonResp({}, 404)
  })

  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ device_code: 'd1' }),
  })
  expect(res.status).toBe(200)

  const row = await r.upstreams.getById('up_copilot_u1_42')
  expect(row?.proxyFallbackList).toEqual([{ id: 'px_keep' }])
})

test('a re-paste without a chain keeps the chain already on the row', async () => {
  const r = await realRepo()
  await seedChainedCopilotRow(r)
  stubGlobalFetch(async (input) => {
    const url = String(input)
    if (url.includes('/copilot_internal')) return jsonResp({ token: 'tok' })
    if (url.includes('/user')) {
      return jsonResp({ id: 42, login: 'octo', name: 'Octo Cat', avatar_url: 'https://a/o.png' })
    }
    return jsonResp({}, 404)
  })

  const res = await buildApp({ userId: 'u1' }).request('/auth/github/paste-token', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ github_token: 'gho_x' }),
  })
  expect(res.status).toBe(200)

  const row = await r.upstreams.getById('up_copilot_u1_42')
  expect(row?.proxyFallbackList).toEqual([{ id: 'px_keep' }])
})
