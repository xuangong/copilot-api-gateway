/**
 * Google OAuth router tests — Week 5b.
 *
 * Covers /google (auth start) + /google/callback ported from old
 * src/routes/auth/google.ts. Uses in-memory repo + fetcher override seam
 * (no mock.module — see bun_mock_module_unrestorable memory).
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { setRepoForTest } from '../src/shared/repo/index.ts'
import type {
  InviteCode, Repo, User, UserSession,
} from '../src/shared/repo/types.ts'
import { authRouter } from '../src/control-plane/auth/routes.ts'
import { setGoogleFetcherForTest } from '../src/control-plane/auth/google-routes.ts'
import { resetAuthStoresForTest, saveOAuthState } from '../src/control-plane/auth/stores.ts'

function inMemoryRepo() {
  const users = new Map<string, User>()
  const sessions = new Map<string, UserSession>()
  const invites = new Map<string, InviteCode>()

  const repo = {
    users: {
      create: async (u: User) => { users.set(u.id, u) },
      getById: async (id: string) => users.get(id) ?? null,
      findByKey: async () => null,
      findByEmail: async (email: string) =>
        [...users.values()].find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null,
      list: async () => [...users.values()],
      update: async (id: string, fields: Partial<User>) => {
        const u = users.get(id); if (u) users.set(id, { ...u, ...fields })
      },
      delete: async (id: string) => { users.delete(id) },
    },
    sessions: {
      create: async (s: UserSession) => { sessions.set(s.token, s) },
      findByToken: async (t: string) => sessions.get(t) ?? null,
      deleteByUserId: async () => { }, deleteExpired: async () => { },
    },
    inviteCodes: {
      create: async (i: InviteCode) => { invites.set(i.id, i) },
      findByCode: async (code: string) =>
        [...invites.values()].find((i) => i.code === code) ?? null,
      list: async () => [...invites.values()],
      markUsed: async (id: string, userId: string) => {
        const i = invites.get(id)
        if (i) invites.set(id, { ...i, usedAt: new Date().toISOString(), usedBy: userId })
      },
      clearUsedBy: async () => { }, delete: async () => { },
    },
    apiKeys: {
      list: async () => [], listByOwner: async () => [], findByRawKey: async () => null,
      getById: async () => null, save: async () => { }, delete: async () => { }, deleteAll: async () => { },
    },
    github: {
      listAccounts: async () => [], listAccountsByOwner: async () => [], getAccount: async () => null,
      saveAccount: async () => { }, deleteAccount: async () => { }, deleteAllAccounts: async () => { },
      getActiveId: async () => null, setActiveId: async () => { }, clearActiveId: async () => { },
      getActiveIdForUser: async () => null, setActiveIdForUser: async () => { }, clearActiveIdForUser: async () => { },
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

  return { repo, users, sessions, invites }
}

function buildApp(env: { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string } = {
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec',
}) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.env = { ...(c.env ?? {}), ...env }
    return next()
  })
  app.route('/auth', authRouter)
  return app
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
}

let store: ReturnType<typeof inMemoryRepo>

beforeEach(() => {
  store = inMemoryRepo()
  setRepoForTest(store.repo)
  resetAuthStoresForTest()
})

afterEach(() => {
  setGoogleFetcherForTest(null)
})

// --- GET /google ---

test('GET /google missing clientId → 500', async () => {
  const res = await buildApp({}).request('/auth/google')
  expect(res.status).toBe(500)
})

test('GET /google redirects to accounts.google.com with state', async () => {
  const res = await buildApp().request('/auth/google', { redirect: 'manual' })
  expect(res.status).toBe(302)
  const loc = res.headers.get('location') ?? ''
  expect(loc).toContain('https://accounts.google.com/o/oauth2/v2/auth')
  const url = new URL(loc)
  expect(url.searchParams.get('client_id')).toBe('cid')
  expect(url.searchParams.get('response_type')).toBe('code')
  expect(url.searchParams.get('scope')).toBe('openid email profile')
  expect(url.searchParams.get('prompt')).toBe('select_account')
  expect(url.searchParams.get('state')).toBeTruthy()
  expect(url.searchParams.get('redirect_uri')).toContain('/auth/google/callback')
})

// --- GET /google/callback error branches ---

test('callback missing config → 500 html', async () => {
  const res = await buildApp({}).request('/auth/google/callback?code=c&state=s')
  expect(res.status).toBe(500)
  expect(res.headers.get('content-type') ?? '').toContain('text/html')
})

test('callback oauth error param → 400 html', async () => {
  const res = await buildApp().request('/auth/google/callback?error=access_denied')
  expect(res.status).toBe(400)
})

test('callback missing code/state → 400', async () => {
  const res = await buildApp().request('/auth/google/callback')
  expect(res.status).toBe(400)
})

test('callback invalid state → 400', async () => {
  const res = await buildApp().request('/auth/google/callback?code=c&state=nope')
  expect(res.status).toBe(400)
})

test('callback token exchange fail → 502', async () => {
  await saveOAuthState('st1', { createdAt: Date.now() })
  setGoogleFetcherForTest(async () => new Response('bad', { status: 400 }))
  const res = await buildApp().request('/auth/google/callback?code=c&state=st1')
  expect(res.status).toBe(502)
})

test('callback userinfo fail → 502', async () => {
  await saveOAuthState('st2', { createdAt: Date.now() })
  let call = 0
  setGoogleFetcherForTest(async () => {
    call += 1
    if (call === 1) return jsonResp({ access_token: 'at' })
    return new Response('nope', { status: 401 })
  })
  const res = await buildApp().request('/auth/google/callback?code=c&state=st2')
  expect(res.status).toBe(502)
})

// --- happy path: existing user ---

test('callback existing user → 302 to /dashboard + cookies', async () => {
  await store.repo.users.create({
    id: 'u1', name: 'Old', email: 'existing@x.com',
    createdAt: 'x', disabled: false,
  })
  await saveOAuthState('st3', { createdAt: Date.now() })

  let call = 0
  setGoogleFetcherForTest(async () => {
    call += 1
    if (call === 1) return jsonResp({ access_token: 'at' })
    return jsonResp({
      email: 'existing@x.com', name: 'Old Name',
      picture: 'https://pic/old.png',
    })
  })

  const res = await buildApp().request(
    '/auth/google/callback?code=c&state=st3', { redirect: 'manual' },
  )
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('/dashboard')
  const cookie = res.headers.get('set-cookie') ?? ''
  expect(cookie).toContain('session_token=ses_')
  expect(cookie).toContain('user_avatar=')
  expect(cookie).toContain('user_name=')
  expect(store.sessions.size).toBe(1)

  // user updated with avatar + lastLoginAt
  const u = await store.repo.users.findByEmail('existing@x.com')
  expect(u?.avatarUrl).toBe('https://pic/old.png')
  expect(u?.lastLoginAt).toBeTruthy()
})

test('callback disabled user → 403 html', async () => {
  await store.repo.users.create({
    id: 'u1', name: 'D', email: 'disabled@x.com',
    createdAt: 'x', disabled: true,
  })
  await saveOAuthState('st4', { createdAt: Date.now() })

  let call = 0
  setGoogleFetcherForTest(async () => {
    call += 1
    if (call === 1) return jsonResp({ access_token: 'at' })
    return jsonResp({ email: 'disabled@x.com', name: 'D' })
  })

  const res = await buildApp().request('/auth/google/callback?code=c&state=st4')
  expect(res.status).toBe(403)
})

// --- admin auto-register (ADMIN_EMAILS includes test@local.dev) ---

test('callback admin email auto-creates user', async () => {
  await saveOAuthState('st5', { createdAt: Date.now() })
  let call = 0
  setGoogleFetcherForTest(async () => {
    call += 1
    if (call === 1) return jsonResp({ access_token: 'at' })
    return jsonResp({ email: 'test@local.dev', name: 'Admin' })
  })
  const res = await buildApp().request(
    '/auth/google/callback?code=c&state=st5', { redirect: 'manual' },
  )
  expect(res.status).toBe(302)
  const u = await store.repo.users.findByEmail('test@local.dev')
  expect(u).toBeDefined()
  expect(u?.name).toBe('Admin')
  expect(store.sessions.size).toBe(1)
})

// --- invite code branch ---

test('callback with invite code creates user + marks invite', async () => {
  await store.repo.inviteCodes.create({
    id: 'inv1', code: 'WELCOME', name: 'Inv', createdAt: 'x',
  })
  await saveOAuthState('st6', { inviteCode: 'WELCOME', createdAt: Date.now() })
  let call = 0
  setGoogleFetcherForTest(async () => {
    call += 1
    if (call === 1) return jsonResp({ access_token: 'at' })
    return jsonResp({ email: 'newbie@x.com', name: 'Newbie' })
  })
  const res = await buildApp().request(
    '/auth/google/callback?code=c&state=st6', { redirect: 'manual' },
  )
  expect(res.status).toBe(302)
  const u = await store.repo.users.findByEmail('newbie@x.com')
  expect(u).toBeDefined()
  const inv = [...store.invites.values()][0]
  expect(inv?.usedBy).toBe(u?.id)
})

test('callback with used invite → 400 html', async () => {
  await store.repo.inviteCodes.create({
    id: 'inv1', code: 'USED', name: 'Inv', createdAt: 'x',
    usedAt: 'y', usedBy: 'other',
  })
  await saveOAuthState('st7', { inviteCode: 'USED', createdAt: Date.now() })
  let call = 0
  setGoogleFetcherForTest(async () => {
    call += 1
    if (call === 1) return jsonResp({ access_token: 'at' })
    return jsonResp({ email: 'new2@x.com', name: 'N' })
  })
  const res = await buildApp().request('/auth/google/callback?code=c&state=st7')
  expect(res.status).toBe(400)
})

test('callback no invite + non-admin → 403 html', async () => {
  await saveOAuthState('st8', { createdAt: Date.now() })
  let call = 0
  setGoogleFetcherForTest(async () => {
    call += 1
    if (call === 1) return jsonResp({ access_token: 'at' })
    return jsonResp({ email: 'random@x.com', name: 'R' })
  })
  const res = await buildApp().request('/auth/google/callback?code=c&state=st8')
  expect(res.status).toBe(403)
})
