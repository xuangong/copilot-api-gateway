/**
 * Email auth router tests — Week 5b.
 *
 * Covers /email/{register,verify,login,change-password,magic} ported from
 * old src/routes/auth/email.ts. Uses the real in-memory SQLite repo + email-sender override
 * + auth-store reset (no mock.module — see bun_mock_module_unrestorable memory).
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { setupTestPlatform } from './_setup-platform.ts'
import { authRouter } from '../src/control-plane/auth/routes.ts'
import { setEmailSenderForTest, type EmailSender } from '../src/control-plane/lib/email.ts'
import {
  resetAuthStoresForTest,
  saveMagicToken,
} from '../src/control-plane/auth/stores.ts'
import { hashPassword } from '../src/control-plane/lib/password.ts'

function buildApp() {
  const app = new Hono()
  app.route('/auth', authRouter)
  return app
}

interface Captured {
  codes: Array<{ to: string; code: string }>
  magic: Array<{ to: string; link: string }>
}

function captureSender(captured: Captured): EmailSender {
  return {
    sendVerificationCode: async (to, code) => {
      captured.codes.push({ to, code }); return true
    },
    sendMagicLink: async (to, link) => {
      captured.magic.push({ to, link }); return true
    },
  }
}

let repo: ReturnType<typeof setupTestPlatform>['repo']
let db: ReturnType<typeof setupTestPlatform>['db']
let mail: Captured

const sessionCount = () => (db.query('SELECT COUNT(*) AS n FROM user_sessions').get() as { n: number }).n

beforeEach(() => {
  ;({ repo, db } = setupTestPlatform())
  resetAuthStoresForTest()
  mail = { codes: [], magic: [] }
  setEmailSenderForTest(captureSender(mail))
})

const J = { 'content-type': 'application/json' }

// --- /email/register ---

test('register missing fields → 400', async () => {
  const res = await buildApp().request('/auth/email/register', {
    method: 'POST', body: '{}', headers: J,
  })
  expect(res.status).toBe(400)
})

test('register short password → 400', async () => {
  const res = await buildApp().request('/auth/email/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'a@b.com', invite_code: 'X', name: 'A', password: '123' }),
    headers: J,
  })
  expect(res.status).toBe(400)
})

test('register invalid invite → 400', async () => {
  const res = await buildApp().request('/auth/email/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'a@b.com', invite_code: 'NOPE', name: 'A', password: '123456' }),
    headers: J,
  })
  expect(res.status).toBe(400)
})

test('register duplicate email → 409', async () => {
  await repo.inviteCodes.create({ id: 'i1', code: 'OK', name: 'A', createdAt: 'x' })
  await repo.users.create({
    id: 'u1', name: 'A', email: 'dup@x.com', createdAt: 'x', disabled: false,
  })
  const res = await buildApp().request('/auth/email/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'dup@x.com', invite_code: 'OK', name: 'A', password: '123456' }),
    headers: J,
  })
  expect(res.status).toBe(409)
})

test('register success sends code', async () => {
  await repo.inviteCodes.create({ id: 'i1', code: 'OK', name: 'A', createdAt: 'x' })
  const res = await buildApp().request('/auth/email/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'New@X.com', invite_code: 'OK', name: 'New', password: '123456' }),
    headers: J,
  })
  expect(res.status).toBe(200)
  expect(mail.codes).toHaveLength(1)
  expect(mail.codes[0]?.to).toBe('new@x.com')
  expect(mail.codes[0]?.code).toMatch(/^\d{6}$/)
})

// --- /email/verify ---

test('verify wrong code → 400', async () => {
  await repo.inviteCodes.create({ id: 'i1', code: 'OK', name: 'A', createdAt: 'x' })
  await buildApp().request('/auth/email/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'v@x.com', invite_code: 'OK', name: 'V', password: '123456' }),
    headers: J,
  })
  const res = await buildApp().request('/auth/email/verify', {
    method: 'POST', body: JSON.stringify({ email: 'v@x.com', code: '000000' }), headers: J,
  })
  expect(res.status).toBe(400)
})

test('verify success creates user + session + marks invite', async () => {
  await repo.inviteCodes.create({ id: 'i1', code: 'OK', name: 'A', createdAt: 'x' })
  await buildApp().request('/auth/email/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'v@x.com', invite_code: 'OK', name: 'V', password: 'pw1234' }),
    headers: J,
  })
  const sentCode = mail.codes[0]!.code
  const res = await buildApp().request('/auth/email/verify', {
    method: 'POST', body: JSON.stringify({ email: 'v@x.com', code: sentCode }), headers: J,
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.ok).toBe(true)
  expect(body.redirect).toBe('/dashboard')

  expect((res.headers.get('set-cookie') ?? '')).toContain('session_token=ses_')

  const u = await repo.users.findByEmail('v@x.com')
  expect(u).toBeDefined()
  expect(u?.passwordHash?.startsWith('pbkdf2:')).toBe(true)
  expect(sessionCount()).toBe(1)
  expect((await repo.inviteCodes.list())[0]?.usedBy).toBe(u?.id)
})

// --- /email/login ---

test('login unknown email → 404', async () => {
  const res = await buildApp().request('/auth/email/login', {
    method: 'POST', body: JSON.stringify({ email: 'nope@x.com', password: 'abc123' }), headers: J,
  })
  expect(res.status).toBe(404)
})

test('login disabled → 403', async () => {
  const hash = await hashPassword('pw1234')
  await repo.users.create({
    id: 'u1', name: 'A', email: 'd@x.com', createdAt: 'x', disabled: true, passwordHash: hash,
  })
  const res = await buildApp().request('/auth/email/login', {
    method: 'POST', body: JSON.stringify({ email: 'd@x.com', password: 'pw1234' }), headers: J,
  })
  expect(res.status).toBe(403)
})

test('login oauth-only account → 400', async () => {
  await repo.users.create({
    id: 'u1', name: 'A', email: 'g@x.com', createdAt: 'x', disabled: false,
  })
  const res = await buildApp().request('/auth/email/login', {
    method: 'POST', body: JSON.stringify({ email: 'g@x.com', password: 'pw1234' }), headers: J,
  })
  expect(res.status).toBe(400)
})

test('login wrong password → 401', async () => {
  const hash = await hashPassword('pw1234')
  await repo.users.create({
    id: 'u1', name: 'A', email: 'l@x.com', createdAt: 'x', disabled: false, passwordHash: hash,
  })
  const res = await buildApp().request('/auth/email/login', {
    method: 'POST', body: JSON.stringify({ email: 'l@x.com', password: 'wrong1' }), headers: J,
  })
  expect(res.status).toBe(401)
})

test('login success creates session + cookies', async () => {
  const hash = await hashPassword('pw1234')
  await repo.users.create({
    id: 'u1', name: 'Logi', email: 'l@x.com', createdAt: 'x', disabled: false,
    passwordHash: hash, avatarUrl: 'https://x/a.png',
  })
  const res = await buildApp().request('/auth/email/login', {
    method: 'POST', body: JSON.stringify({ email: 'l@x.com', password: 'pw1234' }), headers: J,
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie') ?? ''
  expect(cookie).toContain('session_token=ses_')
  expect(cookie).toContain('user_name=Logi')
  expect(cookie).toContain('user_avatar=')
  expect(sessionCount()).toBe(1)
})

// --- /email/change-password ---

test('change-password no session → 401', async () => {
  const res = await buildApp().request('/auth/email/change-password', {
    method: 'POST', body: '{}', headers: J,
  })
  expect(res.status).toBe(401)
})

test('change-password updates hash', async () => {
  const hash = await hashPassword('old123')
  await repo.users.create({
    id: 'u1', name: 'A', email: 'c@x.com', createdAt: 'x', disabled: false, passwordHash: hash,
  })
  await repo.sessions.create({
    token: 'ses_cp', userId: 'u1', createdAt: 'x',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  })
  const res = await buildApp().request('/auth/email/change-password', {
    method: 'POST',
    body: JSON.stringify({ old_password: 'old123', new_password: 'new456' }),
    headers: { ...J, cookie: 'session_token=ses_cp' },
  })
  expect(res.status).toBe(200)
  const u = await repo.users.getById('u1')
  expect(u?.passwordHash).not.toBe(hash)
})

test('change-password wrong old → 401', async () => {
  const hash = await hashPassword('old123')
  await repo.users.create({
    id: 'u1', name: 'A', email: 'c@x.com', createdAt: 'x', disabled: false, passwordHash: hash,
  })
  await repo.sessions.create({
    token: 'ses_cp2', userId: 'u1', createdAt: 'x',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  })
  const res = await buildApp().request('/auth/email/change-password', {
    method: 'POST',
    body: JSON.stringify({ old_password: 'WRONG', new_password: 'new456' }),
    headers: { ...J, cookie: 'session_token=ses_cp2' },
  })
  expect(res.status).toBe(401)
})

test('change-password same → 400', async () => {
  const hash = await hashPassword('same12')
  await repo.users.create({
    id: 'u1', name: 'A', email: 'c@x.com', createdAt: 'x', disabled: false, passwordHash: hash,
  })
  await repo.sessions.create({
    token: 'ses_cp3', userId: 'u1', createdAt: 'x',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  })
  const res = await buildApp().request('/auth/email/change-password', {
    method: 'POST',
    body: JSON.stringify({ old_password: 'same12', new_password: 'same12' }),
    headers: { ...J, cookie: 'session_token=ses_cp3' },
  })
  expect(res.status).toBe(400)
})

// --- /email/magic ---

test('magic missing token → 400 html', async () => {
  const res = await buildApp().request('/auth/email/magic')
  expect(res.status).toBe(400)
  expect(res.headers.get('content-type') ?? '').toContain('text/html')
})

test('magic invalid token → 400 html', async () => {
  const res = await buildApp().request('/auth/email/magic?token=nope')
  expect(res.status).toBe(400)
})

test('magic success redirects to /dashboard + sets cookie', async () => {
  await repo.users.create({
    id: 'u1', name: 'M', email: 'm@x.com', createdAt: 'x', disabled: false,
  })
  await saveMagicToken('tok123', 'm@x.com')
  const res = await buildApp().request('/auth/email/magic?token=tok123', {
    redirect: 'manual',
  })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('/dashboard')
  expect((res.headers.get('set-cookie') ?? '')).toContain('session_token=ses_')
  expect(sessionCount()).toBe(1)
})

test('magic disabled user → 403 html', async () => {
  await repo.users.create({
    id: 'u1', name: 'M', email: 'm@x.com', createdAt: 'x', disabled: true,
  })
  await saveMagicToken('tok456', 'm@x.com')
  const res = await buildApp().request('/auth/email/magic?token=tok456')
  expect(res.status).toBe(403)
})
