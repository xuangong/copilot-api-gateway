/**
 * Device-flow router tests — Week 5b.
 *
 * Covers /device/{code,verify,poll} ported from old src/routes/auth/device.ts.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { setRepoForTest } from '../src/shared/repo/index.ts'
import type {
  DeviceCode, Repo, User, UserSession,
} from '../src/shared/repo/types.ts'
import { authRouter, type AuthCtx } from '../src/control-plane/auth/routes.ts'

function inMemoryRepo() {
  const users = new Map<string, User>()
  const sessions = new Map<string, UserSession>()
  const deviceCodes = new Map<string, DeviceCode>()

  const repo = {
    users: {
      create: async (u: User) => { users.set(u.id, u) },
      getById: async (id: string) => users.get(id) ?? null,
      findByKey: async () => null, findByEmail: async () => null,
      list: async () => [...users.values()],
      update: async () => { }, delete: async () => { },
    },
    sessions: {
      create: async (s: UserSession) => { sessions.set(s.token, s) },
      findByToken: async (t: string) => sessions.get(t) ?? null,
      deleteByUserId: async () => { }, deleteExpired: async () => { },
    },
    deviceCodes: {
      create: async (d: DeviceCode) => { deviceCodes.set(d.deviceCode, d) },
      findByDeviceCode: async (d: string) => deviceCodes.get(d) ?? null,
      findByUserCode: async (u: string) =>
        [...deviceCodes.values()].find((x) => x.userCode === u) ?? null,
      verify: async (d: string, uid: string, st: string) => {
        const e = deviceCodes.get(d)
        if (e) deviceCodes.set(d, { ...e, userId: uid, sessionToken: st })
      },
      deleteExpired: async () => { },
      delete: async (d: string) => { deviceCodes.delete(d) },
    },
    inviteCodes: { create: async () => { }, findByCode: async () => null, list: async () => [], markUsed: async () => { }, clearUsedBy: async () => { }, delete: async () => { } },
    apiKeys: { list: async () => [], listByOwner: async () => [], findByRawKey: async () => null, getById: async () => null, save: async () => { }, delete: async () => { }, deleteAll: async () => { } },
    github: { listAccounts: async () => [], listAccountsByOwner: async () => [], getAccount: async () => null, saveAccount: async () => { }, deleteAccount: async () => { }, deleteAllAccounts: async () => { }, getActiveId: async () => null, setActiveId: async () => { }, clearActiveId: async () => { }, getActiveIdForUser: async () => null, setActiveIdForUser: async () => { }, clearActiveIdForUser: async () => { } },
    keyAssignments: { assign: async () => { }, unassign: async () => { }, listByUser: async () => [], listByKey: async () => [], deleteByKey: async () => { }, deleteByUser: async () => { } },
    observabilityShares: { share: async () => { }, unshare: async () => { }, listByOwner: async () => [], listByViewer: async () => [], isGranted: async () => false, deleteByOwner: async () => { }, deleteByViewer: async () => { } },
  } as unknown as Repo

  return { repo, users, sessions, deviceCodes }
}

function buildApp(auth?: AuthCtx) {
  const app = new Hono()
  if (auth) app.use('*', (c, next) => { c.set('auth', auth); return next() })
  app.route('/auth', authRouter)
  return app
}

const J = { 'content-type': 'application/json' }

let store: ReturnType<typeof inMemoryRepo>
beforeEach(() => {
  store = inMemoryRepo()
  setRepoForTest(store.repo)
})

test('POST /device/code creates pending entry', async () => {
  const res = await buildApp().request('/auth/device/code', { method: 'POST' })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.device_code).toBeTruthy()
  expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  expect(body.expires_in).toBe(900)
  expect(body.interval).toBe(5)
  expect(store.deviceCodes.size).toBe(1)
})

test('POST /device/verify no session → 401', async () => {
  const res = await buildApp().request('/auth/device/verify', {
    method: 'POST', body: JSON.stringify({ user_code: 'ABCD-1234' }), headers: J,
  })
  expect(res.status).toBe(401)
})

test('POST /device/verify missing user_code → 400', async () => {
  const res = await buildApp({ userId: 'u1' }).request('/auth/device/verify', {
    method: 'POST', body: '{}', headers: J,
  })
  expect(res.status).toBe(400)
})

test('POST /device/verify invalid code → 404', async () => {
  const res = await buildApp({ userId: 'u1' }).request('/auth/device/verify', {
    method: 'POST', body: JSON.stringify({ user_code: 'NOPE-NOPE' }), headers: J,
  })
  expect(res.status).toBe(404)
})

test('POST /device/verify expired → 410', async () => {
  await store.repo.deviceCodes.create({
    deviceCode: 'd1', userCode: 'EXPI-RED1',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    createdAt: 'x',
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/device/verify', {
    method: 'POST', body: JSON.stringify({ user_code: 'EXPI-RED1' }), headers: J,
  })
  expect(res.status).toBe(410)
  expect(store.deviceCodes.size).toBe(0)
})

test('POST /device/verify already used → 409', async () => {
  await store.repo.deviceCodes.create({
    deviceCode: 'd1', userCode: 'USED-CODE',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    createdAt: 'x', userId: 'someone', sessionToken: 'ses_x',
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/device/verify', {
    method: 'POST', body: JSON.stringify({ user_code: 'USED-CODE' }), headers: J,
  })
  expect(res.status).toBe(409)
})

test('POST /device/verify success creates session', async () => {
  await store.repo.deviceCodes.create({
    deviceCode: 'd1', userCode: 'GOOD-CODE',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    createdAt: 'x',
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/device/verify', {
    method: 'POST', body: JSON.stringify({ user_code: 'good-code' }), headers: J,
  })
  expect(res.status).toBe(200)
  expect(store.sessions.size).toBe(1)
  const dc = store.deviceCodes.get('d1')
  expect(dc?.userId).toBe('u1')
  expect(dc?.sessionToken?.startsWith('ses_')).toBe(true)
})

test('POST /device/poll missing device_code → 400', async () => {
  const res = await buildApp().request('/auth/device/poll', {
    method: 'POST', body: '{}', headers: J,
  })
  expect(res.status).toBe(400)
})

test('POST /device/poll invalid → 404 expired status', async () => {
  const res = await buildApp().request('/auth/device/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'nope' }), headers: J,
  })
  expect(res.status).toBe(404)
})

test('POST /device/poll expired removes + status:expired', async () => {
  await store.repo.deviceCodes.create({
    deviceCode: 'd1', userCode: 'X',
    expiresAt: new Date(Date.now() - 1000).toISOString(), createdAt: 'x',
  })
  const res = await buildApp().request('/auth/device/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'd1' }), headers: J,
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: 'expired' })
  expect(store.deviceCodes.size).toBe(0)
})

test('POST /device/poll pending', async () => {
  await store.repo.deviceCodes.create({
    deviceCode: 'd1', userCode: 'X',
    expiresAt: new Date(Date.now() + 60000).toISOString(), createdAt: 'x',
  })
  const res = await buildApp().request('/auth/device/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'd1' }), headers: J,
  })
  expect(await res.json()).toEqual({ status: 'pending' })
})

test('POST /device/poll complete returns session_token + user_name + deletes code', async () => {
  await store.repo.users.create({
    id: 'u1', name: 'Alice', email: 'a@x.com', createdAt: 'x', disabled: false,
  })
  await store.repo.deviceCodes.create({
    deviceCode: 'd1', userCode: 'X',
    expiresAt: new Date(Date.now() + 60000).toISOString(), createdAt: 'x',
    userId: 'u1', sessionToken: 'ses_done',
  })
  const res = await buildApp().request('/auth/device/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'd1' }), headers: J,
  })
  expect(await res.json()).toEqual({
    status: 'complete', session_token: 'ses_done', user_id: 'u1', user_name: 'Alice',
  })
  expect(store.deviceCodes.size).toBe(0)
})
