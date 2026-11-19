/**
 * Control-plane auth router tests — Week 5a-impl.
 *
 * Covers /login, /logout, /validate-invite, and /admin/* endpoints ported
 * from old src/routes/auth/{sessions,admin}.ts.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { setupTestPlatform } from './_setup-platform.ts'
import type { ApiKeyId, GitHubAccountId, SessionToken, UserId } from '../src/repo/branded-ids.ts'
import type { GitHubAccount, User } from '../src/repo/types.ts'
import {
  authRouter,
  type AuthCtx,
} from '../src/control-plane/auth/routes.ts'

function mkKey(id: string, ownerId: string) {
  return {
    id, name: id, key: `raw-${id}`, createdAt: 'x', ownerId, webSearchEnabled: true,
    modelMappingsEnabled: false, modelMappings: [],
  } as unknown as Parameters<typeof repo.apiKeys.save>[0]
}

function buildApp(auth?: AuthCtx) {
  const app = new Hono()
  if (auth) {
    app.use('*', (c, next) => {
      c.set('auth', auth)
      return next()
    })
  }
  app.route('/auth', authRouter)
  return app
}

function mkUser(over: Partial<User> = {}): User {
  return {
    id: over.id ?? 'u1',
    name: over.name ?? 'Alice',
    email: over.email ?? 'alice@x.com',
    avatarUrl: over.avatarUrl,
    createdAt: 'x',
    disabled: over.disabled ?? false,
    passwordHash: over.passwordHash,
  }
}

let repo: ReturnType<typeof setupTestPlatform>['repo']

beforeEach(() => {
  ;({ repo } = setupTestPlatform())
})

// --- /login ---

test('POST /login no token → 401', async () => {
  const res = await buildApp().request('/auth/login', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(401)
  expect((await res.json() as any).error).toBe('No session')
})

test('POST /login session in body validates user', async () => {
  await repo.users.create(mkUser({ id: 'u1', email: 'zhangxian1124@gmail.com', avatarUrl: 'https://x/a.png' }))
  await repo.sessions.create({
    token: 'ses_abc', userId: 'u1', createdAt: 'x',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  })
  const res = await buildApp().request('/auth/login', {
    method: 'POST', body: JSON.stringify({ key: 'ses_abc' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.ok).toBe(true)
  expect(body.isAdmin).toBe(true) // ADMIN_EMAILS
  expect(body.userId).toBe('u1')
  expect(body.sessionToken).toBe('ses_abc')
  // Backfill cookie since avatarUrl present and no cookie sent
  const setCookie = res.headers.get('set-cookie') ?? ''
  expect(setCookie).toContain('user_avatar=')
})

test('POST /login session from cookie', async () => {
  await repo.users.create(mkUser({ id: 'u1' }))
  await repo.sessions.create({
    token: 'ses_cookie', userId: 'u1', createdAt: 'x',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  })
  const res = await buildApp().request('/auth/login', {
    method: 'POST', body: '{}',
    headers: { 'content-type': 'application/json', cookie: 'foo=bar; session_token=ses_cookie' },
  })
  expect(res.status).toBe(200)
  expect((await res.json() as any).userId).toBe('u1')
})

test('POST /login disabled user → 403', async () => {
  await repo.users.create(mkUser({ id: 'u1', disabled: true }))
  await repo.sessions.create({
    token: 'ses_x', userId: 'u1', createdAt: 'x',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  })
  const res = await buildApp().request('/auth/login', {
    method: 'POST', body: JSON.stringify({ key: 'ses_x' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(403)
})

test('POST /login expired session → 401', async () => {
  await repo.users.create(mkUser({ id: 'u1' }))
  await repo.sessions.create({
    token: 'ses_exp', userId: 'u1', createdAt: 'x',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  })
  const res = await buildApp().request('/auth/login', {
    method: 'POST', body: JSON.stringify({ key: 'ses_exp' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(401)
})

test('POST /login falls back to API key when token lacks ses_ prefix', async () => {
  await repo.apiKeys.save({
    id: 'k1', name: 'devkey', key: 'rawkey123456',
    createdAt: 'x', ownerId: 'u-owner', webSearchEnabled: true,
    modelMappingsEnabled: false, modelMappings: [],
  })
  const res = await buildApp().request('/auth/login', {
    method: 'POST', body: JSON.stringify({ key: 'rawkey123456' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.ok).toBe(true)
  expect(body.isAdmin).toBe(false)
  expect(body.keyId).toBe('k1')
  expect(body.keyHint).toBe('3456')
})

test('POST /login invalid token → 401', async () => {
  const res = await buildApp().request('/auth/login', {
    method: 'POST', body: JSON.stringify({ key: 'bogus' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(401)
})

// --- /logout & /validate-invite ---

test('POST /logout clears cookie', async () => {
  const res = await buildApp().request('/auth/logout', { method: 'POST' })
  expect(res.status).toBe(200)
  expect((res.headers.get('set-cookie') ?? '')).toContain('session_token=; Path=/')
})

test('POST /validate-invite missing code → 400', async () => {
  const res = await buildApp().request('/auth/validate-invite', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /validate-invite unused returns valid:true', async () => {
  await repo.inviteCodes.create({
    id: 'i1', code: 'ABC123', name: 'Bob', createdAt: 'x',
  })
  const res = await buildApp().request('/auth/validate-invite', {
    method: 'POST', body: JSON.stringify({ code: 'ABC123' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(await res.json()).toEqual({ valid: true, name: 'Bob' })
})

test('POST /validate-invite used returns valid:false', async () => {
  await repo.inviteCodes.create({
    id: 'i1', code: 'USED', name: 'X', createdAt: 'x', usedAt: 'y', usedBy: 'u1',
  })
  const res = await buildApp().request('/auth/validate-invite', {
    method: 'POST', body: JSON.stringify({ code: 'USED' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(await res.json()).toEqual({ valid: false })
})

// --- /admin/invite-codes ---

test('GET /admin/invite-codes non-admin → 403', async () => {
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/auth/admin/invite-codes')
  expect(res.status).toBe(403)
})

test('admin invite-codes lifecycle: list / create / delete', async () => {
  const app = buildApp({ authKind: 'session', userId: 'admin', isAdmin: true })

  let res = await app.request('/auth/admin/invite-codes')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([])

  res = await app.request('/auth/admin/invite-codes', {
    method: 'POST', body: JSON.stringify({ name: 'Bob' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const created = await res.json() as any
  expect(created.name).toBe('Bob')
  expect(typeof created.code).toBe('string')
  expect(created.code.length).toBeGreaterThan(0)

  res = await app.request(`/auth/admin/invite-codes/${created.id}`, { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(await repo.inviteCodes.list()).toHaveLength(0)
})

test('POST /admin/invite-codes missing name → 400', async () => {
  const res = await buildApp({ authKind: 'session', userId: 'admin', isAdmin: true }).request('/auth/admin/invite-codes', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

// --- /admin/users ---

test('GET /admin/users enriches each user with counts', async () => {
  await repo.users.create(mkUser({ id: 'u1' }))
  await repo.apiKeys.save({
    id: 'k1', name: 'k', key: 'kk', createdAt: 'x', ownerId: 'u1', webSearchEnabled: true,
    modelMappingsEnabled: false, modelMappings: [],
  })
  await repo.github.saveAccount(42 as GitHubAccountId, {
    token: 'tok', accountType: 'individual',
    user: { id: 42, login: 'gh', name: 'gh', avatar_url: '' },
    ownerId: 'u1', enabled: true, sortOrder: 0,
  } as GitHubAccount)
  await repo.apiKeys.save(mkKey('k2', 'u2'))
  await repo.keyAssignments.assign('k2' as ApiKeyId, 'u1' as UserId, 'admin' as UserId)

  const res = await buildApp({ authKind: 'session', userId: 'admin', isAdmin: true }).request('/auth/admin/users')
  expect(res.status).toBe(200)
  const body = await res.json() as any[]
  expect(body).toHaveLength(1)
  expect(body[0].id).toBe('u1')
  expect(body[0].keyCount).toBe(1)
  expect(body[0].sharedKeyCount).toBe(1)
  expect(body[0].githubAccounts).toHaveLength(1)
  expect(body[0].githubAccounts[0].login).toBe('gh')
  // avatar_url fallback template applied since saved avatar_url is ''
  expect(body[0].githubAccounts[0].avatar_url).toBe('https://avatars.githubusercontent.com/u/42?v=4')
})

test('POST /admin/users/:id/disable + /enable toggles flag', async () => {
  await repo.users.create(mkUser({ id: 'u1' }))
  const app = buildApp({ authKind: 'session', userId: 'admin', isAdmin: true })

  let res = await app.request('/auth/admin/users/u1/disable', { method: 'POST' })
  expect(res.status).toBe(200)
  expect((await repo.users.getById('u1'))?.disabled).toBe(true)

  res = await app.request('/auth/admin/users/u1/enable', { method: 'POST' })
  expect(res.status).toBe(200)
  expect((await repo.users.getById('u1'))?.disabled).toBe(false)
})

test('POST /admin/users/:id/disable refuses the caller\'s own account', async () => {
  await repo.users.create(mkUser({ id: 'admin' }))
  const res = await buildApp({ authKind: 'session', userId: 'admin', isAdmin: true })
    .request('/auth/admin/users/admin/disable', { method: 'POST' })
  expect(res.status).toBe(400)
  expect((await res.json() as any).error).toBe('You cannot disable your own account')
  expect((await repo.users.getById('admin'))?.disabled).toBe(false)
})

test('DELETE /admin/users/:id refuses the caller\'s own account', async () => {
  await repo.users.create(mkUser({ id: 'admin' }))
  await repo.sessions.create({
    token: 'ses_admin', userId: 'admin', createdAt: 'x',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  })
  const res = await buildApp({ authKind: 'session', userId: 'admin', isAdmin: true })
    .request('/auth/admin/users/admin', { method: 'DELETE' })
  expect(res.status).toBe(400)
  expect((await res.json() as any).error).toBe('You cannot delete your own account')
  expect(await repo.users.getById('admin' as UserId)).not.toBeNull()
  expect(await repo.sessions.findByToken('ses_admin' as SessionToken)).not.toBeNull()
})

test('DELETE /admin/users/:id cascades across repos', async () => {
  await repo.users.create(mkUser({ id: 'u1' }))
  await repo.sessions.create({
    token: 'ses_x', userId: 'u1', createdAt: 'x',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  })
  await repo.apiKeys.save({
    id: 'k1', name: 'k', key: 'kk', createdAt: 'x', ownerId: 'u1', webSearchEnabled: true,
    modelMappingsEnabled: false, modelMappings: [],
  })
  await repo.github.saveAccount(99 as GitHubAccountId, {
    token: 't', accountType: 'individual',
    user: { id: 99, login: 'g', name: 'g', avatar_url: '' },
    ownerId: 'u1', enabled: true, sortOrder: 0,
  } as GitHubAccount)
  await repo.apiKeys.save(mkKey('k2', 'u2'))
  await repo.keyAssignments.assign('k2' as ApiKeyId, 'u1' as UserId, 'admin' as UserId)
  // Rows hanging off u1 in the other repos, plus bystander rows that must survive.
  await repo.users.create(mkUser({ id: 'u2', email: 'u2@x.com' }))
  await repo.users.create(mkUser({ id: 'u3', email: 'u3@x.com' }))
  await repo.observabilityShares.share('u1' as UserId, 'u2' as UserId, 'u1' as UserId)
  await repo.observabilityShares.share('u3' as UserId, 'u1' as UserId, 'u3' as UserId)
  await repo.observabilityShares.share('u2' as UserId, 'u3' as UserId, 'u2' as UserId)
  for (const owner of ['u1', 'u2']) {
    expect(await repo.syncDevices.createWithinLimit({
      id: `sdv_${owner.padEnd(32, "0")}`, ownerId: owner as UserId, label: 'd', secretHash: owner.padEnd(64, "a"),
      upstreamIds: [], createdAt: 'x', lastSyncAt: null,
    }, 5)).toBe(true)
    expect(await repo.telemetry.createSourceWithinLimit({
      id: `tls_${owner.padEnd(32, "0")}`, ownerId: owner as UserId, name: 's', keyHash: owner.padEnd(64, "b"),
      settings: {}, createdAt: 'x', lastPushAt: null,
    }, 5)).toBe(true)
  }

  const res = await buildApp({ authKind: 'session', userId: 'admin', isAdmin: true }).request('/auth/admin/users/u1', { method: 'DELETE' })
  expect(res.status).toBe(200)

  expect(await repo.users.getById('u1' as UserId)).toBeNull()
  expect(await repo.sessions.findByToken('ses_x' as SessionToken)).toBeNull()
  expect(await repo.apiKeys.listByOwner('u1' as UserId)).toHaveLength(0)
  expect(await repo.apiKeys.getById('k1' as ApiKeyId)).toBeNull()
  expect((await repo.github.listAccountsByOwner('u1' as UserId))).toHaveLength(0)
  expect(await repo.keyAssignments.listByUser('u1' as UserId)).toHaveLength(0)
  // Observability shares: both the owner and the viewer side are removed.
  expect(await repo.observabilityShares.listByOwner('u1' as UserId)).toHaveLength(0)
  expect(await repo.observabilityShares.listByViewer('u1' as UserId)).toHaveLength(0)
  expect(await repo.observabilityShares.isGranted('u2' as UserId, 'u3' as UserId)).toBe(true)
  expect(await repo.syncDevices.listByOwner('u1' as UserId)).toEqual([])
  expect(await repo.telemetry.listSources('u1' as UserId)).toEqual([])
  // Only u1's rows go; other users' devices and sources stay.
  expect(await repo.syncDevices.listByOwner('u2' as UserId)).toHaveLength(1)
  expect(await repo.telemetry.listSources('u2' as UserId)).toHaveLength(1)
  expect(await repo.apiKeys.getById('k2' as ApiKeyId)).not.toBeNull()
})
