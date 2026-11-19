/**
 * Google OAuth router tests — Week 5b.
 *
 * Covers /google (auth start) + /google/callback ported from old
 * src/routes/auth/google.ts. Uses the real in-memory SQLite repo + fetcher override seam
 * (no mock.module — see bun_mock_module_unrestorable memory).
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { setupTestPlatform } from './_setup-platform.ts'
import { authRouter } from '../src/control-plane/auth/routes.ts'
import { setGoogleFetcherForTest } from '../src/control-plane/auth/google-routes.ts'
import { resetAuthStoresForTest, saveOAuthState } from '../src/control-plane/auth/stores.ts'
import { jsonResponse as jsonResp } from '@vibe-core/test-utils'

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

let repo: ReturnType<typeof setupTestPlatform>['repo']
let db: ReturnType<typeof setupTestPlatform>['db']

const sessionCount = () => (db.query('SELECT COUNT(*) AS n FROM user_sessions').get() as { n: number }).n

beforeEach(() => {
  ;({ repo, db } = setupTestPlatform())
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

// The `error` query param is fully attacker-controlled and lands in the error
// page body, so it must arrive escaped rather than as live markup.
test('callback reflects the oauth error param escaped, not as markup', async () => {
  const payload = '<script>alert(1)</script>'
  const res = await buildApp().request(
    `/auth/google/callback?error=${encodeURIComponent(payload)}`,
  )
  expect(res.status).toBe(400)
  const html = await res.text()
  expect(html).not.toContain(payload)
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
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
  await repo.users.create({
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
  expect(sessionCount()).toBe(1)

  // user updated with avatar + lastLoginAt
  const u = await repo.users.findByEmail('existing@x.com')
  expect(u?.avatarUrl).toBe('https://pic/old.png')
  expect(u?.lastLoginAt).toBeTruthy()
})

test('callback disabled user → 403 html', async () => {
  await repo.users.create({
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
  const u = await repo.users.findByEmail('test@local.dev')
  expect(u).toBeDefined()
  expect(u?.name).toBe('Admin')
  expect(sessionCount()).toBe(1)
})

// --- invite code branch ---

test('callback with invite code creates user + marks invite', async () => {
  await repo.inviteCodes.create({
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
  const u = await repo.users.findByEmail('newbie@x.com')
  expect(u).toBeDefined()
  const inv = (await repo.inviteCodes.list())[0]
  expect(inv?.usedBy).toBe(u?.id)
})

test('callback with used invite → 400 html', async () => {
  await repo.inviteCodes.create({
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

// Bun.serve never populates c.env, so the router must not dereference it.
// Every other test here injects c.env through middleware, which is why this
// path reached production as a 500 on the Bun deployment.
test('GET /google reads process.env when c.env is absent', async () => {
  const prev = process.env.GOOGLE_CLIENT_ID
  process.env.GOOGLE_CLIENT_ID = 'from-process-env'
  try {
    const bare = new Hono()
    bare.route('/auth', authRouter)
    const res = await bare.request('/auth/google', { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('client_id'))
      .toBe('from-process-env')
  } finally {
    if (prev === undefined) delete process.env.GOOGLE_CLIENT_ID
    else process.env.GOOGLE_CLIENT_ID = prev
  }
})
