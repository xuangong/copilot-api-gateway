/**
 * presence control-plane tests — Week 5b.
 *
 * Covers POST /heartbeat (auth + validation + upsert) and
 * GET /relays (4-branch scoping + redaction in shared view + enrichment).
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vibe-core/platform'
import type {
  ApiKey,
  ClientPresence,
  KeyAssignment,
  Repo,
  UsageRecord,
  User,
} from '../src/shared/repo/types.ts'
import {
  presenceRouter,
  type PresenceAuthCtx,
} from '../src/control-plane/presence/routes.ts'

function inMemoryRepo() {
  const keys = new Map<string, ApiKey>()
  const presence = new Map<string, ClientPresence>()
  const users = new Map<string, User>()
  const assignments: KeyAssignment[] = []
  const usage: UsageRecord[] = []

  const repo = {
    apiKeys: {
      listByOwner: async (ownerId: string) =>
        [...keys.values()].filter((k) => k.ownerId === ownerId),
      getById: async (id: string) => keys.get(id) ?? null,
    },
    keyAssignments: {
      listByUser: async (userId: string) => assignments.filter((a) => a.userId === userId),
    },
    presence: {
      upsert: async (p: ClientPresence) => {
        presence.set(p.clientId, p)
      },
      list: async () => [...presence.values()],
      listByKeyIds: async (ids: string[]) =>
        [...presence.values()].filter((p) => p.keyId && ids.includes(p.keyId)),
    },
    usage: {
      query: async (opts: { keyIds?: string[]; start: string; end: string }) =>
        usage.filter((u) =>
          (!opts.keyIds || opts.keyIds.includes(u.keyId)) && u.hour >= opts.start && u.hour <= opts.end,
        ),
    },
    users: {
      getById: async (id: string) => users.get(id) ?? null,
    },
  } as unknown as Repo

  return { repo, keys, presence, users, assignments, usage }
}

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
  return { id, name, key: `k-${id}`, createdAt: '2026-01-01T00:00:00Z', ownerId } as ApiKey
}

function mkPresence(clientId: string, keyId: string | null, lastSeenAt: string, ownerId: string | null = null, keyName: string = 'k'): ClientPresence {
  return { clientId, clientName: `${clientId}@host`, keyId, keyName, ownerId, gatewayUrl: null, lastSeenAt }
}

let store: ReturnType<typeof inMemoryRepo>

beforeEach(() => {
  store = inMemoryRepo()
  initRepo(store.repo)
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
  store.keys.set('k1', mkKey('k1', 'my-key', 'u1'))
  const app = buildApp({ apiKeyId: 'k1', userId: 'u1' })
  const res = await app.request('/api/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    body: JSON.stringify({ clientId: 'c1', clientName: 'cli', hostname: 'host1', gatewayUrl: 'http://g' }),
  }, TEST_ENV)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  const p = store.presence.get('c1')!
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
  store.keys.set('k1', mkKey('k1', 'mine', 'u1'))
  store.keys.set('k2', mkKey('k2', 'other', 'u2'))
  store.presence.set('c1', mkPresence('c1', 'k1', new Date().toISOString()))
  store.presence.set('c2', mkPresence('c2', 'k2', new Date().toISOString()))

  const res = await buildApp({ userId: 'u1' }).request('/api/relays', {}, TEST_ENV)
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ clientId: string; isOnline: boolean }>
  expect(body).toHaveLength(1)
  expect(body[0].clientId).toBe('c1')
  expect(body[0].isOnline).toBe(true)
})

test('GET /api/relays admin sees all + ownerName enrichment', async () => {
  store.keys.set('k1', mkKey('k1', 'a', 'u1'))
  store.users.set('u1', { id: 'u1', name: 'Alice' } as User)
  store.presence.set('c1', mkPresence('c1', 'k1', new Date(Date.now() - 10 * 60 * 1000).toISOString(), 'u1'))

  const res = await buildApp({ isAdmin: true, userId: 'admin' }).request('/api/relays', {}, TEST_ENV)
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ clientId: string; ownerName: string | null; isOnline: boolean }>
  expect(body).toHaveLength(1)
  expect(body[0].ownerName).toBe('Alice')
  expect(body[0].isOnline).toBe(false) // 10min > 3min threshold
})

test('GET /api/relays isActive=true when usage exists for key', async () => {
  store.keys.set('k1', mkKey('k1', 'a', 'u1'))
  store.presence.set('c1', mkPresence('c1', 'k1', new Date().toISOString()))
  const nowHour = new Date().toISOString().slice(0, 13)
  store.usage.push({
    keyId: 'k1', model: 'm', hour: nowHour, client: 't', upstream: null,
    requests: 1, inputTokens: 1, outputTokens: 1,
    cacheReadTokens: 0, cacheCreationTokens: 0, costJson: null,
  })

  const res = await buildApp({ userId: 'u1' }).request('/api/relays', {}, TEST_ENV)
  const body = await res.json() as Array<{ isActive: boolean }>
  expect(body[0].isActive).toBe(true)
})

test('GET /api/relays shared-view: owned-only + redacted', async () => {
  store.keys.set('k-owned', mkKey('k-owned', 'owned', 'owner'))
  store.presence.set('c1', mkPresence('c1', 'k-owned', new Date().toISOString(), 'owner', 'owned'))

  const res = await buildApp({
    userId: 'viewer', isViewingShared: true, ownerId: 'owner',
  }).request('/api/relays', {}, TEST_ENV)
  expect(res.status).toBe(200)
  const body = await res.json() as Array<Record<string, unknown>>
  expect(body).toHaveLength(1)
  // redactForSharedView('relays') → { id, clientLabel, status, isOnline, isActive, lastSeenAt }
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
