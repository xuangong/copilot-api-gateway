/**
 * presence control-plane tests — Week 5b.
 *
 * Covers POST /heartbeat (auth + validation + upsert) and
 * GET /relays (4-branch scoping + redaction in shared view + enrichment).
 */
import { test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { setupTestPlatform } from './_setup-platform.ts'
import { __resetPlatformForTests } from '@vibe-core/platform'
import type { ApiKey, ClientPresence, UsageRecord, User } from '../src/repo/types.ts'
import {
  presenceRouter,
  type PresenceAuthCtx,
} from '../src/control-plane/presence/routes.ts'

const TEST_ENV = { SERVER_SECRET: 'test-secret' }

function buildApp(auth: PresenceAuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api', presenceRouter)
  return app
}

function mkKey(id: string, name: string, ownerId?: string): ApiKey {
  return { id, name, key: `k-${id}`, createdAt: '2026-01-01T00:00:00Z', ownerId, modelMappingsEnabled: false, modelMappings: [] } as ApiKey
}

function mkPresence(clientId: string, keyId: string | null, lastSeenAt: string, ownerId: string | null = null, keyName: string = 'k'): ClientPresence {
  return { clientId, clientName: `${clientId}@host`, keyId, keyName, ownerId, gatewayUrl: null, lastSeenAt }
}

let repo: ReturnType<typeof setupTestPlatform>['repo']

beforeEach(() => {
  ;({ repo } = setupTestPlatform())
})

afterEach(() => {
  __resetPlatformForTests()
})

test('POST /api/heartbeat without apiKeyId → 401', async () => {
  const app = buildApp({ userId: 'u1' })
  const res = await app.request('/api/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'c1', hostname: 'h' }),
  }, TEST_ENV)
  expect(res.status).toBe(401)
})

test('POST /api/heartbeat missing clientId or hostname → 400', async () => {
  const app = buildApp({ apiKeyId: 'k1', userId: 'u1' })
  const res = await app.request('/api/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'c1' }),
  }, TEST_ENV)
  expect(res.status).toBe(400)
})

test('POST /api/heartbeat upserts presence with formatted displayName', async () => {
  await repo.apiKeys.save(mkKey('k1', 'my-key', 'u1'))
  const app = buildApp({ apiKeyId: 'k1', userId: 'u1' })
  const res = await app.request('/api/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    body: JSON.stringify({ clientId: 'c1', clientName: 'cli', hostname: 'host1', gatewayUrl: 'http://g' }),
  }, TEST_ENV)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  const p = (await repo.presence.list()).find((x) => x.clientId === 'c1')!
  expect(p.clientName).toBe('cli@host1 (1.2.3.4)')
  expect(p.keyId).toBe('k1')
  expect(p.keyName).toBe('my-key')
  expect(p.ownerId).toBe('u1')
  expect(p.gatewayUrl).toBe('http://g')
})

test('GET /api/relays no auth → []', async () => {
  const app = buildApp({})
  const res = await app.request('/api/relays', {}, TEST_ENV)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([])
})

test('GET /api/relays user scopes to own+assigned keys + isOnline computed', async () => {
  await repo.apiKeys.save(mkKey('k1', 'mine', 'u1'))
  await repo.apiKeys.save(mkKey('k2', 'other', 'u2'))
  await repo.presence.upsert(mkPresence('c1', 'k1', new Date().toISOString()))
  await repo.presence.upsert(mkPresence('c2', 'k2', new Date().toISOString()))

  const res = await buildApp({ userId: 'u1' }).request('/api/relays', {}, TEST_ENV)
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ clientId: string; isOnline: boolean }>
  expect(body).toHaveLength(1)
  expect(body[0].clientId).toBe('c1')
  expect(body[0].isOnline).toBe(true)
})

test('GET /api/relays admin sees all + ownerName enrichment', async () => {
  await repo.apiKeys.save(mkKey('k1', 'a', 'u1'))
  await repo.users.create({ id: 'u1', name: 'Alice', createdAt: '2026-01-01T00:00:00Z', disabled: false } as User)
  await repo.presence.upsert(mkPresence('c1', 'k1', new Date(Date.now() - 10 * 60 * 1000).toISOString(), 'u1'))

  const res = await buildApp({ isAdmin: true, userId: 'admin' }).request('/api/relays', {}, TEST_ENV)
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ clientId: string; ownerName: string | null; isOnline: boolean }>
  expect(body).toHaveLength(1)
  expect(body[0].ownerName).toBe('Alice')
  expect(body[0].isOnline).toBe(false) // 10min > 3min threshold
})

test('GET /api/relays prunes rows past the 30-day TTL before listing', async () => {
  await repo.apiKeys.save(mkKey('k1', 'a', 'u1'))
  const day = 24 * 60 * 60 * 1000
  await repo.presence.upsert(mkPresence('fresh', 'k1', new Date().toISOString()))
  await repo.presence.upsert(mkPresence('stale', 'k1', new Date(Date.now() - 31 * day).toISOString()))

  const res = await buildApp({ userId: 'u1' }).request('/api/relays', {}, TEST_ENV)
  const body = await res.json() as Array<{ clientId: string }>

  expect(body.map((r) => r.clientId)).toEqual(['fresh'])
  // Actually deleted, not merely filtered out of the response.
  expect((await repo.presence.list()).some((x) => x.clientId === 'stale')).toBe(false)
})

test('GET /api/relays keeps a row that is offline but inside the TTL', async () => {
  await repo.apiKeys.save(mkKey('k1', 'a', 'u1'))
  const lastSeen = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString()
  await repo.presence.upsert(mkPresence('c1', 'k1', lastSeen))

  const res = await buildApp({ userId: 'u1' }).request('/api/relays', {}, TEST_ENV)
  const body = await res.json() as Array<{ clientId: string; isOnline: boolean }>

  expect(body).toHaveLength(1)
  expect(body[0].isOnline).toBe(false)
})

test('GET /api/relays survives a prune failure', async () => {
  await repo.apiKeys.save(mkKey('k1', 'a', 'u1'))
  await repo.presence.upsert(mkPresence('c1', 'k1', new Date().toISOString()))
  const prune = spyOn(repo.presence, 'pruneStale').mockImplementationOnce(async () => {
    throw new Error('D1 unavailable')
  })

  const res = await buildApp({ userId: 'u1' }).request('/api/relays', {}, TEST_ENV)

  expect(res.status).toBe(200)
  expect(await res.json()).toHaveLength(1)
  expect(prune).toHaveBeenCalledTimes(1)
  prune.mockRestore()
})

test('GET /api/relays no longer reports isActive', async () => {
  // isActive was a per-key predicate rendered per-device: usage on one device
  // lit up every other device sharing that key. Removed rather than fixed —
  // `usage` has no client_id, so the device-level fact is not computable.
  await repo.apiKeys.save(mkKey('k1', 'a', 'u1'))
  await repo.presence.upsert(mkPresence('c1', 'k1', new Date().toISOString()))
  const nowHour = new Date().toISOString().slice(0, 13)
  await repo.usage.record({
    keyId: 'k1', incomingModel: 'm', model: 'm', modelKey: 'm', hour: nowHour, client: 't', upstream: null,
    requests: 1, tokens: { input: 1, output: 1 }, cost: null,
  } as UsageRecord)

  const res = await buildApp({ userId: 'u1' }).request('/api/relays', {}, TEST_ENV)
  const body = await res.json() as Array<Record<string, unknown>>
  expect(body[0]).not.toHaveProperty('isActive')
})

test('GET /api/relays shared-view: owned-only + redacted', async () => {
  await repo.apiKeys.save(mkKey('k-owned', 'owned', 'owner'))
  await repo.presence.upsert(mkPresence('c1', 'k-owned', new Date().toISOString(), 'owner', 'owned'))

  const res = await buildApp({
    userId: 'viewer', isViewingShared: true, ownerId: 'owner',
  }).request('/api/relays', {}, TEST_ENV)
  expect(res.status).toBe(200)
  const body = await res.json() as Array<Record<string, unknown>>
  expect(body).toHaveLength(1)
  // redactForSharedView('relays') → { id, clientLabel, status, isOnline, lastSeenAt }
  expect(body[0].clientLabel).toBe('owned')
  expect(body[0].status).toBe('connected')
  expect(body[0].id).not.toBe('c1')
})

test('GET /api/relays shared-view with no owned keys → []', async () => {
  const res = await buildApp({
    userId: 'viewer', isViewingShared: true, ownerId: 'owner',
  }).request('/api/relays', {}, TEST_ENV)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([])
})
