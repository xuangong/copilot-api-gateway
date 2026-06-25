/**
 * token-usage control-plane tests — Week 5b.
 *
 * Per bun_mock_module_unrestorable: in-memory repo + setRepoForTest.
 * Covers 4 scoping branches + redaction in shared view.
 *
 * Cost in the response is summed from each row's frozen per-dimension price
 * snapshot (UsageRecord.cost), not from a global pricing table — see
 * aggregate.ts.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vibe-core/platform'
import type {
  ApiKey,
  KeyAssignment,
  Repo,
  UsageRecord,
  User,
} from '../src/shared/repo/types.ts'
import {
  tokenUsageRouter,
  type TokenUsageAuthCtx,
} from '../src/control-plane/token-usage/routes.ts'

function inMemoryRepo() {
  const keys = new Map<string, ApiKey>()
  const usage: UsageRecord[] = []
  const users = new Map<string, User>()
  const assignments: KeyAssignment[] = []

  const repo = {
    apiKeys: {
      list: async () => [...keys.values()],
      listByOwner: async (ownerId: string) =>
        [...keys.values()].filter((k) => k.ownerId === ownerId),
      getById: async (id: string) => keys.get(id) ?? null,
    },
    usage: {
      query: async (opts: { keyId?: string; keyIds?: string[]; start: string; end: string }) =>
        usage.filter((u) => {
          if (opts.keyId && u.keyId !== opts.keyId) return false
          if (opts.keyIds && !opts.keyIds.includes(u.keyId)) return false
          return u.hour >= opts.start && u.hour <= opts.end
        }),
    },
    users: {
      getById: async (id: string) => users.get(id) ?? null,
    },
    keyAssignments: {
      listByUser: async (userId: string) => assignments.filter((a) => a.userId === userId),
    },
  } as unknown as Repo

  return { repo, keys, usage, users, assignments }
}

const TEST_ENV = { SERVER_SECRET: 'test-secret' }

function buildApp(auth: TokenUsageAuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api', tokenUsageRouter)
  return app
}

function call(app: ReturnType<typeof buildApp>, path: string) {
  return app.request(path, {}, TEST_ENV)
}

function mkKey(id: string, name: string, ownerId?: string): ApiKey {
  return { id, name, key: `k-${id}`, createdAt: '2026-01-01T00:00:00Z', ownerId } as ApiKey
}

function mkUsage(keyId: string, hour: string, model = 'claude-sonnet-4-6'): UsageRecord {
  // input=1000 × $3/M + output=500 × $15/M = 0.003 + 0.0075 = 0.0105 USD
  return {
    keyId, model, modelKey: model, hour, client: 'test', upstream: null,
    requests: 1,
    tokens: { input: 1000, output: 500 },
    cost: { input: 3, output: 15 },
  }
}

let store: ReturnType<typeof inMemoryRepo>

beforeEach(() => {
  store = inMemoryRepo()
  initRepo(store.repo)
})

afterEach(() => {
  __resetPlatformForTests()
})

test('GET /api/token-usage missing start/end → 400', async () => {
  const res = await call(buildApp({ userId: 'u1' }), '/api/token-usage')
  expect(res.status).toBe(400)
})

test('GET /api/token-usage user with no keys → []', async () => {
  const res = await call(buildApp({ userId: 'u1' }), '/api/token-usage?start=2026-01-01T00&end=2026-12-31T23')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([])
})

test('GET /api/token-usage user scopes to own + assigned keys; aggregates cost from per-row snapshot + keyName', async () => {
  store.keys.set('k1', mkKey('k1', 'mine', 'u1'))
  store.keys.set('k2', mkKey('k2', 'other', 'u2'))
  store.keys.set('k3', mkKey('k3', 'assigned', 'u3'))
  store.assignments.push({ keyId: 'k3', userId: 'u1', assignedBy: 'admin', assignedAt: '' })
  store.usage.push(mkUsage('k1', '2026-03-01T00'))
  store.usage.push(mkUsage('k2', '2026-03-01T00'))
  store.usage.push(mkUsage('k3', '2026-03-01T01'))

  const res = await call(buildApp({ userId: 'u1' }), '/api/token-usage?start=2026-03-01T00&end=2026-03-01T23')
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ keyId: string; keyName: string; cost: number; tokens: { input?: number; output?: number } }>
  const seen = body.map((r) => r.keyId).sort()
  expect(seen).toEqual(['k1', 'k3'])
  const k1 = body.find((r) => r.keyId === 'k1')!
  expect(k1.keyName).toBe('mine')
  expect(k1.tokens.input).toBe(1000)
  expect(k1.tokens.output).toBe(500)
  expect(k1.cost).toBeCloseTo(0.0105, 6)
})

test('GET /api/token-usage admin sees all keys + ownerId/ownerName enrichment', async () => {
  store.keys.set('k1', mkKey('k1', 'alpha', 'u1'))
  store.keys.set('k2', mkKey('k2', 'beta', 'u2'))
  store.users.set('u1', { id: 'u1', name: 'Alice' } as User)
  store.users.set('u2', { id: 'u2', name: 'Bob' } as User)
  store.usage.push(mkUsage('k1', '2026-03-01T00'))
  store.usage.push(mkUsage('k2', '2026-03-01T00'))

  const res = await call(buildApp({ isAdmin: true, userId: 'admin' }), '/api/token-usage?start=2026-03-01T00&end=2026-03-01T23')
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ keyId: string; ownerId: string; ownerName: string }>
  expect(body).toHaveLength(2)
  const byKey = Object.fromEntries(body.map((r) => [r.keyId, r]))
  expect(byKey.k1.ownerName).toBe('Alice')
  expect(byKey.k2.ownerName).toBe('Bob')
})

test('GET /api/token-usage shared-view: owned-only + HMAC-redacted keyId', async () => {
  store.keys.set('k-owned', mkKey('k-owned', 'owned-key', 'owner'))
  store.keys.set('k-assigned', mkKey('k-assigned', 'assigned-key', 'someone-else'))
  store.assignments.push({ keyId: 'k-assigned', userId: 'owner', assignedBy: 'admin', assignedAt: '' })
  store.usage.push(mkUsage('k-owned', '2026-03-01T00'))
  store.usage.push(mkUsage('k-assigned', '2026-03-01T00'))

  const res = await call(buildApp({ userId: 'viewer', isViewingShared: true, ownerId: 'owner' }), '/api/token-usage?start=2026-03-01T00&end=2026-03-01T23')
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ keyId: string; keyName: string }>
  // only owned key surfaces; assigned excluded by getOwnedKeyIdsForScope
  expect(body).toHaveLength(1)
  // keyId is HMAC surrogate (16 chars base64url), not the real id
  expect(body[0].keyId).not.toBe('k-owned')
  expect(body[0].keyId).toMatch(/^[A-Za-z0-9_-]{16}$/)
  expect(body[0].keyName).toBe('owned-key')
})

test('GET /api/token-usage shared-view with no owned keys → []', async () => {
  const res = await call(buildApp({ userId: 'viewer', isViewingShared: true, ownerId: 'owner' }), '/api/token-usage?start=2026-03-01T00&end=2026-03-01T23')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([])
})
