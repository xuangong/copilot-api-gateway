/**
 * GitHub OAuth router tests — Week 5b.
 *
 * Covers /github, /github/poll (github.com and *.ghe.com tenants), /me, DELETE /github/:id,
 * /github/switch ported from old src/routes/auth/github.ts, plus the auth
 * guard on the two device-flow routes. Every case runs against the real
 * in-memory SQLite repo (setupTestPlatform), so the proxies table exists and
 * chains round-trip the real column plumbing. Every case stubs
 * `globalThis.fetch` for every outbound call (no mock.module — see
 * bun_mock_module_unrestorable memory).
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { setupTestPlatform } from './_setup-platform.ts'
import type { GitHubAccountId, UserId } from '../src/repo/branded-ids.ts'
import type { UpstreamRecord } from '../src/repo/types.ts'
import { authRouter, type AuthCtx } from '../src/control-plane/auth/routes.ts'
import { copilotUpstreamRowId } from '../src/control-plane/lib/github.ts'
import { createFetchStub } from '@vibe-core/test-utils'
import { jsonResponse as jsonResp } from '@vibe-core/test-utils'

// Restores the global fetch after every test in this file.
const stubGlobalFetch = createFetchStub()

function buildApp(auth?: AuthCtx) {
  const app = new Hono()
  if (auth) app.use('*', (c, next) => { c.set('auth', auth); return next() })
  app.route('/auth', authRouter)
  return app
}

const J = { 'content-type': 'application/json' }

/** A /copilot_internal/v2/token payload; `api` is the advertised data plane. */
function copilotTokenBody(api: string | null = 'https://api.individual.githubcopilot.com') {
  return {
    token: 'tid=copilot', expires_at: Math.floor(Date.now() / 1000) + 1800, refresh_in: 1500,
    ...(api ? { endpoints: { api } } : {}),
  }
}

let repo: ReturnType<typeof setupTestPlatform>['repo']

beforeEach(() => {
  // setupTestPlatform resets the platform singletons and installs a fresh
  // in-memory SQLite repo plus the runtime location the control-plane fetcher
  // resolution needs (tests have no bootstrap).
  ;({ repo } = setupTestPlatform())
  // Default stub so no test reaches the real network; individual tests
  // replace it with a stub shaped for the calls they exercise.
  stubGlobalFetch(async () => jsonResp({ copilot_plan: 'individual' }))
})

const account = (userId: number, ownerId: string) =>
  repo.github.getAccount(userId as GitHubAccountId, ownerId as UserId)
const activeFor = (ownerId: string) => repo.github.getActiveIdForUser(ownerId as UserId)

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
  // The `/user` branch also answers detectCopilotAccountType's
  // /copilot_internal/user probe; that payload carries no `copilot_plan`, so
  // detectCopilotAccountType falls back to 'individual' — the same account type the
  // previous two-seam setup produced.
  stubGlobalFetch(async (input) => {
    call += 1
    const url = input.url
    if (url.includes('/oauth/access_token')) {
      return jsonResp({ access_token: 'gho_abc' })
    }
    if (url.includes('/copilot_internal/v2/token')) return jsonResp(copilotTokenBody())
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
  const acct = await account(42, 'u1')
  expect(acct?.token).toBe('gho_abc')
  expect(acct?.user.login).toBe('octo')
  expect(await activeFor('u1')).toBe(42)

  // mirrored into upstreams
  const upId = copilotUpstreamRowId('u1', 42)
  const up = await repo.upstreams.getById(upId)
  expect(up).toBeDefined()
  expect(up?.provider).toBe('copilot')
  expect(up?.name).toBe('octo')
})

// --- auth guard on the device-flow routes ---

/*
 * The real repo has an (empty) proxies table, so were the auth guard removed the
 * request would reach the proxy resolver and come back 400 with
 * "unknown proxy id in fallback list: px_missing" — the very oracle the guard
 * closes. That is what the body assertions below discriminate against.
 */

test('POST /github unauthenticated → 401 that does not confirm or deny the proxy id', async () => {
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
  await repo.github.saveAccount(99 as GitHubAccountId, {
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
  await repo.github.saveAccount(99 as GitHubAccountId, {
    token: 't', accountType: 'individual',
    user: { id: 99, login: 'g', name: null, avatar_url: '' },
    ownerId: 'other',
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/me')
  const body = await res.json() as any
  expect(body.github_connected).toBe(false)
})

test('GET /me user sees github_connected=true when own account exists', async () => {
  await repo.github.saveAccount(7 as GitHubAccountId, {
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
  await repo.github.saveAccount(42 as GitHubAccountId, {
    token: 't', accountType: 'individual',
    user: { id: 42, login: 'me', name: null, avatar_url: '' },
    ownerId: 'u1',
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/42', {
    method: 'DELETE',
  })
  expect(res.status).toBe(200)
  expect(await account(42, 'u1')).toBeNull()
})

// --- POST /github/switch ---

// buildApp() with no argument mounts no auth middleware, which is exactly what
// session-auth.ts does for an unauthenticated caller: it leaves `auth` unset
// rather than setting a userId-less context (session-auth.ts:108).

test('DELETE /github/:id without auth → 401 and the account survives', async () => {
  await repo.github.saveAccount(42 as GitHubAccountId, {
    token: 't', accountType: 'individual',
    user: { id: 42, login: 'me', name: null, avatar_url: '' },
    ownerId: 'u1',
  })
  const res = await buildApp().request('/auth/github/42', { method: 'DELETE' })
  expect(res.status).toBe(401)
  // Without the guard the undefined ownerId reaches the unscoped DELETE, so
  // asserting the row is still there is what actually pins the fix.
  expect(await account(42, 'u1')).not.toBeNull()
})

test('DELETE /github/:id checks auth before the id shape', async () => {
  // An unauthenticated caller must not learn whether the id parsed.
  const res = await buildApp().request('/auth/github/abc', { method: 'DELETE' })
  expect(res.status).toBe(401)
})

test('POST /github/switch without auth → 401 and no global active id is set', async () => {
  await repo.github.saveAccount(7 as GitHubAccountId, {
    token: 't', accountType: 'individual',
    user: { id: 7, login: 'me', name: null, avatar_url: '' },
  })
  const res = await buildApp().request('/auth/github/switch', {
    method: 'POST', body: JSON.stringify({ user_id: 7 }), headers: J,
  })
  expect(res.status).toBe(401)
  expect(await repo.github.getActiveId()).toBe(null)
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
  await repo.github.saveAccount(7 as GitHubAccountId, {
    token: 't', accountType: 'individual',
    user: { id: 7, login: 'me', name: null, avatar_url: '' },
    ownerId: 'u1',
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/switch', {
    method: 'POST', body: JSON.stringify({ user_id: 7 }), headers: J,
  })
  expect(res.status).toBe(200)
  expect(await activeFor('u1')).toBe(7)
})

// --- draft proxy chain ---

test('POST /github with an unknown proxy id → 400 naming the id but not the url', async () => {
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
  const r = repo
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
  const r = repo
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

test('a successful device-flow login persists the submitted chain', async () => {
  const r = repo
  stubGlobalFetch(async (input) => {
    const url = input.url
    if (url.includes('/oauth/access_token')) return jsonResp({ access_token: 'gho_abc' })
    if (url.includes('/copilot_internal/v2/token')) return jsonResp(copilotTokenBody())
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
 * case below logs back in as.
 */
async function seedChainedCopilotRow(r: typeof repo) {
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
 * The complement of the "persists the submitted chain" path: an *absent*
 * `proxy_fallback_list` must reach `addGithubAccount` as `undefined`, which
 * lib/github.ts:79-82 reads as "keep the row's existing chain". Sending `[]`
 * instead would look harmless but silently wipes a chain the user edited after
 * their first login, and on a proxy-only host that turns the account's egress
 * direct. Verified by mutation: `proxyFallbackList: proxy_fallback_list ?? []`
 * in the device-flow poll passes every other case in this file and fails only
 * this one.
 *
 * The case submits no chain, so `egressFetcher` returns undefined and the
 * route keeps globalThis.fetch — the stub below answers every outbound call,
 * and `px_keep` never has to be dialled.
 */
test('a re-login without a chain keeps the chain already on the row', async () => {
  const r = repo
  await seedChainedCopilotRow(r)
  stubGlobalFetch(async (input) => {
    const url = input.url
    if (url.includes('/oauth/access_token')) return jsonResp({ access_token: 'gho_abc' })
    if (url.includes('/copilot_internal/v2/token')) return jsonResp(copilotTokenBody())
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

// --- GHE.com tenants (SUBDOMAIN.ghe.com) ---
//
// Device flow runs against the tenant's own web origin with the same public
// client id as github.com; REST lives at api.SUBDOMAIN.ghe.com; the data plane
// is whatever /copilot_internal/v2/token advertises in endpoints.api.

test('POST /github with a ghe.com host starts the device flow on the tenant', async () => {
  const urls: string[] = []
  stubGlobalFetch(async (input) => {
    urls.push(input.url)
    return jsonResp({
      device_code: 'dev123', user_code: 'ABCD-EFGH', verification_uri: 'https://acme.ghe.com/login/device',
      expires_in: 900, interval: 5,
    })
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/github', {
    method: 'POST', headers: J, body: JSON.stringify({ github_host: ' Acme.GHE.com ' }),
  })
  expect(res.status).toBe(200)
  expect(urls).toEqual(['https://acme.ghe.com/login/device/code'])
  expect(((await res.json()) as any).verification_uri).toBe('https://acme.ghe.com/login/device')
})

test('POST /github rejects a host that is neither github.com nor *.ghe.com before any fetch', async () => {
  let direct = 0
  stubGlobalFetch(async () => { direct += 1; return jsonResp({}) })
  for (const github_host of ['evil.example.com', 'ghe.com', 'a.b.ghe.com']) {
    const res = await buildApp({ userId: 'u1' }).request('/auth/github', {
      method: 'POST', headers: J, body: JSON.stringify({ github_host }),
    })
    expect(res.status).toBe(400)
  }
  expect(direct).toBe(0)
})

test('POST /github/poll with a ghe.com host talks to the tenant and stores host + data plane', async () => {
  const urls: string[] = []
  stubGlobalFetch(async (input) => {
    const url = input.url
    urls.push(url)
    if (url.includes('/login/oauth/access_token')) return jsonResp({ access_token: 'ghu_tenant' })
    if (url.endsWith('/copilot_internal/v2/token')) return jsonResp(copilotTokenBody('https://copilot-api.acme.ghe.com'))
    if (url.endsWith('/copilot_internal/user')) return jsonResp({ copilot_plan: 'enterprise' })
    if (url.endsWith('/user')) return jsonResp({ id: 7, login: 'alice_acme', name: 'Alice', avatar_url: '' })
    return jsonResp({}, 404)
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST', headers: J, body: JSON.stringify({ device_code: 'd1', github_host: 'acme.ghe.com' }),
  })
  expect(res.status).toBe(200)
  expect(((await res.json()) as any).status).toBe('complete')

  expect(urls).toContain('https://acme.ghe.com/login/oauth/access_token')
  expect(urls).toContain('https://api.acme.ghe.com/user')
  expect(urls).toContain('https://api.acme.ghe.com/copilot_internal/v2/token')
  expect(urls.some(u => u.includes('github.com/') && !u.includes('ghe.com'))).toBe(false)

  const acct = await account(7, 'u1')
  expect(acct?.githubHost).toBe('acme.ghe.com')
  expect(acct?.accountType).toBe('enterprise')
  const up = await repo.upstreams.getById(copilotUpstreamRowId('u1', 7))
  expect(up?.config).toMatchObject({ githubHost: 'acme.ghe.com', githubToken: 'ghu_tenant', source: 'device-flow' })
  expect(up?.state).toMatchObject({ copilotApiEndpoint: 'https://copilot-api.acme.ghe.com' })
})

test('POST /github/poll refuses a ghe.com login whose token exchange advertises no data plane', async () => {
  stubGlobalFetch(async (input) => {
    const url = input.url
    if (url.includes('/login/oauth/access_token')) return jsonResp({ access_token: 'ghu_tenant' })
    if (url.endsWith('/copilot_internal/v2/token')) return jsonResp(copilotTokenBody(null))
    if (url.endsWith('/user')) return jsonResp({ id: 7, login: 'alice_acme', name: 'Alice', avatar_url: '' })
    return jsonResp({}, 404)
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST', headers: J, body: JSON.stringify({ device_code: 'd1', github_host: 'acme.ghe.com' }),
  })
  expect(res.status).toBe(502)
  expect(((await res.json()) as any).status).toBe('error')
  expect(await account(7, 'u1')).toBeNull()
  expect(await repo.upstreams.getById(copilotUpstreamRowId('u1', 7))).toBeNull()
})

test('POST /github/poll refuses a login whose GitHub token has no Copilot access', async () => {
  stubGlobalFetch(async (input) => {
    const url = input.url
    if (url.includes('/login/oauth/access_token')) return jsonResp({ access_token: 'gho_nocopilot' })
    if (url.endsWith('/copilot_internal/v2/token')) return jsonResp({ message: 'Not Found' }, 404)
    if (url.endsWith('/user')) return jsonResp({ id: 9, login: 'nocopilot', name: null, avatar_url: '' })
    return jsonResp({}, 404)
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST', headers: J, body: JSON.stringify({ device_code: 'd1' }),
  })
  expect(res.status).toBe(502)
  expect(await account(9, 'u1')).toBeNull()
})
