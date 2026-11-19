/**
 * Device-flow router tests — Week 5b.
 *
 * Covers /device/{code,verify,poll} ported from old src/routes/auth/device.ts.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { setupTestPlatform } from './_setup-platform.ts'
import type { DeviceCodeToken } from '../src/repo/branded-ids.ts'
import { authRouter, type AuthCtx } from '../src/control-plane/auth/routes.ts'

function buildApp(auth?: AuthCtx) {
  const app = new Hono()
  if (auth) app.use('*', (c, next) => { c.set('auth', auth); return next() })
  app.route('/auth', authRouter)
  return app
}

const J = { 'content-type': 'application/json' }

let repo: ReturnType<typeof setupTestPlatform>['repo']
let db: ReturnType<typeof setupTestPlatform>['db']
beforeEach(() => {
  ;({ repo, db } = setupTestPlatform())
})

const rowCount = (table: 'device_codes' | 'user_sessions') =>
  (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

test('POST /device/code creates pending entry', async () => {
  const res = await buildApp().request('/auth/device/code', { method: 'POST' })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.device_code).toBeTruthy()
  expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  expect(body.expires_in).toBe(900)
  expect(body.interval).toBe(5)
  expect(rowCount('device_codes')).toBe(1)
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
  await repo.deviceCodes.create({
    deviceCode: 'd1', userCode: 'EXPI-RED1',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    createdAt: 'x',
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/device/verify', {
    method: 'POST', body: JSON.stringify({ user_code: 'EXPI-RED1' }), headers: J,
  })
  expect(res.status).toBe(410)
  expect(rowCount('device_codes')).toBe(0)
})

test('POST /device/verify already used → 409', async () => {
  await repo.deviceCodes.create({
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
  await repo.deviceCodes.create({
    deviceCode: 'd1', userCode: 'GOOD-CODE',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    createdAt: 'x',
  })
  const res = await buildApp({ userId: 'u1' }).request('/auth/device/verify', {
    method: 'POST', body: JSON.stringify({ user_code: 'good-code' }), headers: J,
  })
  expect(res.status).toBe(200)
  expect(rowCount('user_sessions')).toBe(1)
  const dc = await repo.deviceCodes.findByDeviceCode('d1' as DeviceCodeToken)
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
  await repo.deviceCodes.create({
    deviceCode: 'd1', userCode: 'X',
    expiresAt: new Date(Date.now() - 1000).toISOString(), createdAt: 'x',
  })
  const res = await buildApp().request('/auth/device/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'd1' }), headers: J,
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: 'expired' })
  expect(rowCount('device_codes')).toBe(0)
})

test('POST /device/poll pending', async () => {
  await repo.deviceCodes.create({
    deviceCode: 'd1', userCode: 'X',
    expiresAt: new Date(Date.now() + 60000).toISOString(), createdAt: 'x',
  })
  const res = await buildApp().request('/auth/device/poll', {
    method: 'POST', body: JSON.stringify({ device_code: 'd1' }), headers: J,
  })
  expect(await res.json()).toEqual({ status: 'pending' })
})

test('POST /device/poll complete returns session_token + user_name + deletes code', async () => {
  await repo.users.create({
    id: 'u1', name: 'Alice', email: 'a@x.com', createdAt: 'x', disabled: false,
  })
  await repo.deviceCodes.create({
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
  expect(rowCount('device_codes')).toBe(0)
})
