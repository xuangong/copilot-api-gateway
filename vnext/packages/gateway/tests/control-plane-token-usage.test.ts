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
import { initRepo } from '../src/repo/index.ts'
import { __resetPlatformForTests } from '@vibe-core/platform'
import type {
  ApiKey,
  KeyAssignment,
  Repo,
  UsageRecord,
  User,
} from '../src/repo/types.ts'
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
      listByKey: async (keyId: string) => assignments.filter((a) => a.keyId === keyId),
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
  return { id, name, key: `k-${id}`, createdAt: '2026-01-01T00:00:00Z', ownerId, modelMappingsEnabled: false, modelMappings: [] } as ApiKey
}

function mkUsage(
  keyId: string,
  hour: string,
  model = 'claude-sonnet-4-6',
  incomingModel = model,
): UsageRecord {
  // input=1000 × $3/M + output=500 × $15/M = 0.003 + 0.0075 = 0.0105 USD
  return {
    keyId, incomingModel, model, modelKey: model, hour, client: 'test', upstream: null,
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

test('GET /api/token-usage user exposes distinct incoming aliases without duplicating requests', async () => {
  store.keys.set('k1', mkKey('k1', 'mine', 'u1'))
  store.usage.push(mkUsage('k1', '2026-03-01T00', 'target-model', 'alias-a'))
  store.usage.push(mkUsage('k1', '2026-03-01T00', 'target-model', 'alias-b'))
  store.usage.push(mkUsage('k1', '2026-03-01T01', 'target-model', ''))

  const res = await call(buildApp({ userId: 'u1' }), '/api/token-usage?start=2026-03-01T00&end=2026-03-01T23')
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ incomingModel: string; model: string; requests: number }>
  expect(body.map((row) => [row.incomingModel, row.model, row.requests])).toEqual([
    ['alias-a', 'target-model', 1],
    ['alias-b', 'target-model', 1],
    ['', 'target-model', 1],
  ])
  expect(body.reduce((total, row) => total + row.requests, 0)).toBe(3)
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
  const body = await res.json() as Array<{ keyId: string; incomingModel: string; ownerId: string; ownerName: string }>
  expect(body).toHaveLength(2)
  const byKey = Object.fromEntries(body.map((r) => [r.keyId, r]))
  expect(byKey.k1.ownerName).toBe('Alice')
  expect(byKey.k1.incomingModel).toBe('claude-sonnet-4-6')
  expect(byKey.k2.ownerName).toBe('Bob')
  expect(byKey.k2.incomingModel).toBe('claude-sonnet-4-6')
})

test('GET /api/token-usage shared-view: owned-only + HMAC-redacted keyId', async () => {
  store.keys.set('k-owned', mkKey('k-owned', 'owned-key', 'owner'))
  store.keys.set('k-assigned', mkKey('k-assigned', 'assigned-key', 'someone-else'))
  store.assignments.push({ keyId: 'k-assigned', userId: 'owner', assignedBy: 'admin', assignedAt: '' })
  store.usage.push(mkUsage('k-owned', '2026-03-01T00'))
  store.usage.push(mkUsage('k-assigned', '2026-03-01T00'))

  const res = await call(buildApp({ userId: 'viewer', isViewingShared: true, ownerId: 'owner' }), '/api/token-usage?start=2026-03-01T00&end=2026-03-01T23')
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ keyId: string; keyName: string; incomingModel: string }>
  // only owned key surfaces; assigned excluded by getOwnedKeyIdsForScope
  expect(body).toHaveLength(1)
  // keyId is HMAC surrogate (16 chars base64url), not the real id
  expect(body[0].keyId).not.toBe('k-owned')
  expect(body[0].keyId).toMatch(/^[A-Za-z0-9_-]{16}$/)
  expect(body[0].keyName).toBe('owned-key')
  expect(body[0].incomingModel).toBe('claude-sonnet-4-6')
})

test('GET /api/token-usage shared-view with no owned keys → []', async () => {
  const res = await call(buildApp({ userId: 'viewer', isViewingShared: true, ownerId: 'owner' }), '/api/token-usage?start=2026-03-01T00&end=2026-03-01T23')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([])
})

// --- GET /api/token-usage/participants ------------------------------------
//
// Tells the Usage tab who can use each key, so a key shared through
// key_assignments stops looking like it belongs to its owner alone. Carries no
// key material — that is why it exists instead of reusing GET /api/keys.

interface ParticipantsRow {
  keyId: string
  ownerId: string | null
  ownerName: string | null
  sharedWith: Array<{ id: string; name: string }>
}

const participants = async (auth: TokenUsageAuthCtx) => {
  const res = await call(buildApp(auth), '/api/token-usage/participants')
  return { res, body: (await res.json()) as ParticipantsRow[] }
}

test('participants: admin sees every key with its owner and assignees', async () => {
  store.keys.set('k1', mkKey('k1', 'team', 'u1'))
  store.keys.set('k2', mkKey('k2', 'solo', 'u2'))
  store.users.set('u1', { id: 'u1', name: 'Alice' } as User)
  store.users.set('u2', { id: 'u2', name: 'Bob' } as User)
  store.users.set('u3', { id: 'u3', name: 'Carol' } as User)
  store.assignments.push({ keyId: 'k1', userId: 'u2', assignedBy: 'admin', assignedAt: '' })
  store.assignments.push({ keyId: 'k1', userId: 'u3', assignedBy: 'admin', assignedAt: '' })

  const { res, body } = await participants({ isAdmin: true, userId: 'admin' })
  expect(res.status).toBe(200)
  const byKey = Object.fromEntries(body.map((r) => [r.keyId, r]))
  expect(byKey.k1!.ownerName).toBe('Alice')
  expect(byKey.k1!.sharedWith.map((u) => u.name).sort()).toEqual(['Bob', 'Carol'])
  expect(byKey.k2!.sharedWith).toEqual([])
})

test('participants: a key with no owner reports null rather than being dropped', async () => {
  store.keys.set('k1', mkKey('k1', 'orphan'))
  const { body } = await participants({ isAdmin: true, userId: 'admin' })
  expect(body).toEqual([{ keyId: 'k1', ownerId: null, ownerName: null, sharedWith: [] }])
})

test('participants: response carries no key material', async () => {
  store.keys.set('k1', mkKey('k1', 'team', 'u1'))
  const { body } = await participants({ isAdmin: true, userId: 'admin' })
  expect(JSON.stringify(body)).not.toContain('k-k1')
})

// Matches the Keys tab, which only lists assignees to the key's owner: being
// given access to a key does not entitle you to the roster of who else has it.
test('participants: a non-owner sees the owner but not their fellow assignees', async () => {
  store.keys.set('k-own', mkKey('k-own', 'mine', 'u1'))
  store.keys.set('k-shared', mkKey('k-shared', 'theirs', 'u9'))
  store.users.set('u1', { id: 'u1', name: 'Alice' } as User)
  store.users.set('u2', { id: 'u2', name: 'Bob' } as User)
  store.users.set('u9', { id: 'u9', name: 'Zoe' } as User)
  store.assignments.push({ keyId: 'k-own', userId: 'u2', assignedBy: 'admin', assignedAt: '' })
  store.assignments.push({ keyId: 'k-shared', userId: 'u1', assignedBy: 'admin', assignedAt: '' })
  store.assignments.push({ keyId: 'k-shared', userId: 'u2', assignedBy: 'admin', assignedAt: '' })

  const { body } = await participants({ userId: 'u1' })
  const byKey = Object.fromEntries(body.map((r) => [r.keyId, r]))
  expect(byKey['k-own']!.sharedWith.map((u) => u.name)).toEqual(['Bob'])
  expect(byKey['k-shared']!.ownerName).toBe('Zoe')
  expect(byKey['k-shared']!.sharedWith).toEqual([])
})

// The shared view HMAC-rewrites keyIds, so participants could not be joined to
// usage anyway — and the names would leak identities the viewer never sees.
test('participants: shared view gets nothing', async () => {
  store.keys.set('k1', mkKey('k1', 'owned', 'owner'))
  store.users.set('owner', { id: 'owner', name: 'Olive' } as User)
  const { body } = await participants({ userId: 'viewer', isViewingShared: true, ownerId: 'owner' })
  expect(body).toEqual([])
})

test('participants: a caller with neither admin nor a user id gets nothing', async () => {
  store.keys.set('k1', mkKey('k1', 'owned', 'owner'))
  const { body } = await participants({})
  expect(body).toEqual([])
})
