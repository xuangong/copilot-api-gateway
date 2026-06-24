/**
 * Control-plane auth router tests — Week 5a-impl.
 *
 * Covers /login, /logout, /validate-invite, and /admin/* endpoints ported
 * from old src/routes/auth/{sessions,admin}.ts.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vnext-gateway/platform'
import type {
  ApiKey, GitHubAccount, InviteCode, KeyAssignment,
  Repo, User, UserSession,
} from '../src/shared/repo/types.ts'
import {
  authRouter,
  type AuthCtx,
} from '../src/control-plane/auth/routes.ts'

function inMemoryRepo() {
  const users = new Map<string, User>()
  const sessions = new Map<string, UserSession>()
  const invites = new Map<string, InviteCode>()
  const apiKeys = new Map<string, ApiKey>()
  const githubAccounts = new Map<string, GitHubAccount[]>() // ownerId → []
  const keyAssignments: KeyAssignment[] = []
  const observabilityShareDeletes: string[] = []

  const repo = {
    users: {
      create: async (u: User) => { users.set(u.id, u) },
      getById: async (id: string) => users.get(id) ?? null,
      findByKey: async () => null,
      findByEmail: async () => null,
      list: async () => [...users.values()],
      update: async (id: string, fields: Partial<User>) => {
        const u = users.get(id); if (u) users.set(id, { ...u, ...fields })
      },
      delete: async (id: string) => { users.delete(id) },
    },
    sessions: {
      create: async (s: UserSession) => { sessions.set(s.token, s) },
      findByToken: async (t: string) => sessions.get(t) ?? null,
      deleteByUserId: async (uid: string) => {
        for (const [t, s] of sessions) if (s.userId === uid) sessions.delete(t)
      },
      deleteExpired: async () => { },
    },
    inviteCodes: {
      create: async (i: InviteCode) => { invites.set(i.id, i) },
      findByCode: async (code: string) =>
        [...invites.values()].find((i) => i.code === code) ?? null,
      list: async () => [...invites.values()],
      markUsed: async () => { },
      clearUsedBy: async (uid: string) => {
        for (const [id, i] of invites) if (i.usedBy === uid) invites.set(id, { ...i, usedAt: undefined, usedBy: undefined })
      },
      delete: async (id: string) => { invites.delete(id) },
    },
    apiKeys: {
      list: async () => [...apiKeys.values()],
      listByOwner: async (oid: string) => [...apiKeys.values()].filter((k) => k.ownerId === oid),
      findByRawKey: async (raw: string) => [...apiKeys.values()].find((k) => k.key === raw) ?? null,
      getById: async (id: string) => apiKeys.get(id) ?? null,
      save: async (k: ApiKey) => { apiKeys.set(k.id, k) },
      delete: async (id: string) => apiKeys.delete(id),
      deleteAll: async () => { apiKeys.clear() },
    },
    github: {
      listAccounts: async () => [...githubAccounts.values()].flat(),
      listAccountsByOwner: async (oid: string) => githubAccounts.get(oid) ?? [],
      getAccount: async () => null,
      saveAccount: async (_uid: number, a: GitHubAccount) => {
        const oid = a.ownerId ?? ''
        const list = githubAccounts.get(oid) ?? []
        list.push(a); githubAccounts.set(oid, list)
      },
      deleteAccount: async (uid: number, oid?: string) => {
        const list = githubAccounts.get(oid ?? '') ?? []
        githubAccounts.set(oid ?? '', list.filter((a) => a.user.id !== uid))
      },
      deleteAllAccounts: async () => { githubAccounts.clear() },
      getActiveId: async () => null,
      setActiveId: async () => { },
      clearActiveId: async () => { },
      getActiveIdForUser: async () => null,
      setActiveIdForUser: async () => { },
      clearActiveIdForUser: async (oid: string) => { githubAccounts.delete(oid) },
    },
    keyAssignments: {
      assign: async (kid: string, uid: string, by: string) => {
        keyAssignments.push({ keyId: kid, userId: uid, assignedBy: by, assignedAt: 'x' })
      },
      unassign: async () => { },
      listByUser: async (uid: string) => keyAssignments.filter((a) => a.userId === uid),
      listByKey: async (kid: string) => keyAssignments.filter((a) => a.keyId === kid),
      deleteByKey: async () => { },
      deleteByUser: async (uid: string) => {
        for (let i = keyAssignments.length - 1; i >= 0; i--) {
          if (keyAssignments[i]!.userId === uid) keyAssignments.splice(i, 1)
        }
      },
    },
    observabilityShares: {
      share: async () => { },
      unshare: async () => { },
      listByOwner: async () => [],
      listByViewer: async () => [],
      isGranted: async () => false,
      deleteByOwner: async (oid: string) => { observabilityShareDeletes.push(`owner:${oid}`) },
      deleteByViewer: async (vid: string) => { observabilityShareDeletes.push(`viewer:${vid}`) },
    },
  } as unknown as Repo

  return { repo, users, sessions, invites, apiKeys, githubAccounts, keyAssignments, observabilityShareDeletes }
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

let store: ReturnType<typeof inMemoryRepo>

beforeEach(() => {
  store = inMemoryRepo()
  initRepo(store.repo)
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
  await store.repo.users.create(mkUser({ id: 'u1', email: 'zhangxian1124@gmail.com', avatarUrl: 'https://x/a.png' }))
  await store.repo.sessions.create({
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
  await store.repo.users.create(mkUser({ id: 'u1' }))
  await store.repo.sessions.create({
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
  await store.repo.users.create(mkUser({ id: 'u1', disabled: true }))
  await store.repo.sessions.create({
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
  await store.repo.users.create(mkUser({ id: 'u1' }))
  await store.repo.sessions.create({
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
  await store.repo.apiKeys.save({
    id: 'k1', name: 'devkey', key: 'rawkey123456',
    createdAt: 'x', ownerId: 'u-owner', webSearchEnabled: true,
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
  await store.repo.inviteCodes.create({
    id: 'i1', code: 'ABC123', name: 'Bob', createdAt: 'x',
  })
  const res = await buildApp().request('/auth/validate-invite', {
    method: 'POST', body: JSON.stringify({ code: 'ABC123' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(await res.json()).toEqual({ valid: true, name: 'Bob' })
})

test('POST /validate-invite used returns valid:false', async () => {
  await store.repo.inviteCodes.create({
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
  expect(store.invites.size).toBe(0)
})

test('POST /admin/invite-codes missing name → 400', async () => {
  const res = await buildApp({ authKind: 'session', userId: 'admin', isAdmin: true }).request('/auth/admin/invite-codes', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

// --- /admin/users ---

test('GET /admin/users enriches each user with counts', async () => {
  await store.repo.users.create(mkUser({ id: 'u1' }))
  await store.repo.apiKeys.save({
    id: 'k1', name: 'k', key: 'kk', createdAt: 'x', ownerId: 'u1', webSearchEnabled: true,
  })
  await store.repo.github.saveAccount(42, {
    token: 'tok', accountType: 'individual',
    user: { id: 42, login: 'gh', name: 'gh', avatar_url: '' },
    ownerId: 'u1', enabled: true, sortOrder: 0,
  } as GitHubAccount)
  await store.repo.keyAssignments.assign('k2', 'u1', 'admin')

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
  await store.repo.users.create(mkUser({ id: 'u1' }))
  const app = buildApp({ authKind: 'session', userId: 'admin', isAdmin: true })

  let res = await app.request('/auth/admin/users/u1/disable', { method: 'POST' })
  expect(res.status).toBe(200)
  expect((await store.repo.users.getById('u1'))?.disabled).toBe(true)

  res = await app.request('/auth/admin/users/u1/enable', { method: 'POST' })
  expect(res.status).toBe(200)
  expect((await store.repo.users.getById('u1'))?.disabled).toBe(false)
})

test('DELETE /admin/users/:id cascades across repos', async () => {
  await store.repo.users.create(mkUser({ id: 'u1' }))
  await store.repo.sessions.create({
    token: 'ses_x', userId: 'u1', createdAt: 'x',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  })
  await store.repo.apiKeys.save({
    id: 'k1', name: 'k', key: 'kk', createdAt: 'x', ownerId: 'u1', webSearchEnabled: true,
  })
  await store.repo.github.saveAccount(99, {
    token: 't', accountType: 'individual',
    user: { id: 99, login: 'g', name: 'g', avatar_url: '' },
    ownerId: 'u1', enabled: true, sortOrder: 0,
  } as GitHubAccount)
  await store.repo.keyAssignments.assign('k2', 'u1', 'admin')

  const res = await buildApp({ authKind: 'session', userId: 'admin', isAdmin: true }).request('/auth/admin/users/u1', { method: 'DELETE' })
  expect(res.status).toBe(200)

  expect(store.users.has('u1')).toBe(false)
  expect(store.sessions.size).toBe(0)
  expect(store.apiKeys.size).toBe(0)
  expect((await store.repo.github.listAccountsByOwner('u1'))).toHaveLength(0)
  expect(await store.repo.keyAssignments.listByUser('u1')).toHaveLength(0)
  expect(store.observabilityShareDeletes).toContain('owner:u1')
  expect(store.observabilityShareDeletes).toContain('viewer:u1')
})
