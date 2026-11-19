/**
 * token-usage control-plane tests — Week 5b.
 *
 * Real in-memory SQLite repo (setupTestPlatform); rows are stored, not stubbed.
 * Covers 4 scoping branches + redaction in shared view.
 *
 * Cost in the response is summed from each row's frozen per-dimension price
 * snapshot (UsageRecord.cost), not from a global pricing table — see
 * aggregate.ts.
 */
import { test, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test'
import { Hono } from 'hono'
import { setupTestPlatform } from './_setup-platform.ts'
import type { ApiKeyId, UserId } from '../src/repo/branded-ids.ts'
import type { ApiKey, UsageRecord, User } from '../src/repo/types.ts'
import {
  tokenUsageRouter,
  type TokenUsageAuthCtx,
} from '../src/control-plane/token-usage/routes.ts'

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

let repo: ReturnType<typeof setupTestPlatform>['repo']
let usageQuery: Mock<typeof repo.usage.query>

beforeEach(() => {
  ;({ repo } = setupTestPlatform())
  // Pass-through spy: counts reads without changing what the real repo returns.
  usageQuery = spyOn(repo.usage, 'query')
})

afterEach(() => {
  usageQuery.mockRestore()
})

const addUser = (id: string, name: string) =>
  repo.users.create({ id, name, createdAt: '2026-01-01T00:00:00Z', disabled: false } as User)
const assign = (keyId: string, userId: string) =>
  repo.keyAssignments.assign(keyId as ApiKeyId, userId as UserId, 'admin' as UserId)

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
  await repo.apiKeys.save(mkKey('k1', 'mine', 'u1'))
  await repo.apiKeys.save(mkKey('k2', 'other', 'u2'))
  await repo.apiKeys.save(mkKey('k3', 'assigned', 'u3'))
  await assign('k3', 'u1')
  await repo.usage.record(mkUsage('k1', '2026-03-01T00'))
  await repo.usage.record(mkUsage('k2', '2026-03-01T00'))
  await repo.usage.record(mkUsage('k3', '2026-03-01T01'))

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
  await repo.apiKeys.save(mkKey('k1', 'mine', 'u1'))
  await repo.usage.record(mkUsage('k1', '2026-03-01T00', 'target-model', 'alias-a'))
  await repo.usage.record(mkUsage('k1', '2026-03-01T00', 'target-model', 'alias-b'))
  await repo.usage.record(mkUsage('k1', '2026-03-01T01', 'target-model', ''))

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

test('GET /api/token-usage without an identity → 401', async () => {
  const res = await call(buildApp({}), '/api/token-usage?start=2026-03-01T00&end=2026-03-01T23')

  expect(res.status).toBe(401)
  expect(await res.json()).toEqual({ error: 'Unauthorized' })
  expect(usageQuery.mock.calls.length).toBe(0)
})

test('GET /api/token-usage API-key caller is scoped to its key and retains aliases and legacy incoming model', async () => {
  await repo.apiKeys.save(mkKey('k1', 'public-key', 'u1'))
  await repo.apiKeys.save(mkKey('k2', 'other-key', 'u2'))
  await repo.usage.record(mkUsage('k1', '2026-03-01T00', 'target-model', 'alias-a'))
  await repo.usage.record(mkUsage('k1', '2026-03-01T00', 'target-model', 'alias-b'))
  await repo.usage.record(mkUsage('k1', '2026-03-01T01', 'target-model', ''))
  await repo.usage.record(mkUsage('k2', '2026-03-01T00', 'target-model', 'other-alias'))

  const res = await call(buildApp({ apiKeyId: 'k1' }), '/api/token-usage?start=2026-03-01T00&end=2026-03-01T23')
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ keyId: string; incomingModel: string; model: string; requests: number }>
  expect(body.map((row) => [row.keyId, row.incomingModel, row.model, row.requests])).toEqual([
    ['k1', 'alias-a', 'target-model', 1],
    ['k1', 'alias-b', 'target-model', 1],
    ['k1', '', 'target-model', 1],
  ])
  expect(body.reduce((total, row) => total + row.requests, 0)).toBe(3)
})

test('GET /api/token-usage API-key caller cannot use key_id to read another key', async () => {
  await repo.apiKeys.save(mkKey('k1', 'public-key', 'u1'))
  await repo.apiKeys.save(mkKey('k2', 'other-key', 'u2'))
  await repo.usage.record(mkUsage('k1', '2026-03-01T00'))
  await repo.usage.record(mkUsage('k2', '2026-03-01T00'))

  const res = await call(buildApp({ apiKeyId: 'k1' }), '/api/token-usage?key_id=k2&start=2026-03-01T00&end=2026-03-01T23')

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([expect.objectContaining({ keyId: 'k1' })])
  expect(usageQuery.mock.calls.length).toBe(1)
})

test('GET /api/token-usage API-key caller remains limited to its key even when it has an owner session identity', async () => {
  await repo.apiKeys.save(mkKey('k1', 'authenticated-key', 'u1'))
  await repo.apiKeys.save(mkKey('k2', 'owner-sibling', 'u1'))
  await repo.apiKeys.save(mkKey('k3', 'assigned-key', 'u2'))
  await assign('k3', 'u1')
  await repo.usage.record(mkUsage('k1', '2026-03-01T00'))
  await repo.usage.record(mkUsage('k2', '2026-03-01T00'))
  await repo.usage.record(mkUsage('k3', '2026-03-01T00'))

  const res = await call(buildApp({ userId: 'u1', apiKeyId: 'k1' }), '/api/token-usage?start=2026-03-01T00&end=2026-03-01T23')

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([expect.objectContaining({ keyId: 'k1' })])
})

test('GET /api/token-usage admin sees all keys + ownerId/ownerName enrichment', async () => {
  await repo.apiKeys.save(mkKey('k1', 'alpha', 'u1'))
  await repo.apiKeys.save(mkKey('k2', 'beta', 'u2'))
  await addUser('u1', 'Alice')
  await addUser('u2', 'Bob')
  await repo.usage.record(mkUsage('k1', '2026-03-01T00'))
  await repo.usage.record(mkUsage('k2', '2026-03-01T00'))

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
  await repo.apiKeys.save(mkKey('k-owned', 'owned-key', 'owner'))
  await repo.apiKeys.save(mkKey('k-assigned', 'assigned-key', 'someone-else'))
  await assign('k-assigned', 'owner')
  await repo.usage.record(mkUsage('k-owned', '2026-03-01T00'))
  await repo.usage.record(mkUsage('k-assigned', '2026-03-01T00'))

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
  await repo.apiKeys.save(mkKey('k1', 'team', 'u1'))
  await repo.apiKeys.save(mkKey('k2', 'solo', 'u2'))
  await addUser('u1', 'Alice')
  await addUser('u2', 'Bob')
  await addUser('u3', 'Carol')
  await assign('k1', 'u2')
  await assign('k1', 'u3')

  const { res, body } = await participants({ isAdmin: true, userId: 'admin' })
  expect(res.status).toBe(200)
  const byKey = Object.fromEntries(body.map((r) => [r.keyId, r]))
  expect(byKey.k1!.ownerName).toBe('Alice')
  expect(byKey.k1!.sharedWith.map((u) => u.name).sort()).toEqual(['Bob', 'Carol'])
  expect(byKey.k2!.sharedWith).toEqual([])
})

test('participants: a key with no owner reports null rather than being dropped', async () => {
  await repo.apiKeys.save(mkKey('k1', 'orphan'))
  const { body } = await participants({ isAdmin: true, userId: 'admin' })
  expect(body).toEqual([{ keyId: 'k1', ownerId: null, ownerName: null, sharedWith: [] }])
})

test('participants: response carries no key material', async () => {
  await repo.apiKeys.save(mkKey('k1', 'team', 'u1'))
  const { body } = await participants({ isAdmin: true, userId: 'admin' })
  expect(JSON.stringify(body)).not.toContain('k-k1')
})

// Matches the Keys tab, which only lists assignees to the key's owner: being
// given access to a key does not entitle you to the roster of who else has it.
test('participants: a non-owner sees the owner but not their fellow assignees', async () => {
  await repo.apiKeys.save(mkKey('k-own', 'mine', 'u1'))
  await repo.apiKeys.save(mkKey('k-shared', 'theirs', 'u9'))
  await addUser('u1', 'Alice')
  await addUser('u2', 'Bob')
  await addUser('u9', 'Zoe')
  await assign('k-own', 'u2')
  await assign('k-shared', 'u1')
  await assign('k-shared', 'u2')

  const { body } = await participants({ userId: 'u1' })
  const byKey = Object.fromEntries(body.map((r) => [r.keyId, r]))
  expect(byKey['k-own']!.sharedWith.map((u) => u.name)).toEqual(['Bob'])
  expect(byKey['k-shared']!.ownerName).toBe('Zoe')
  expect(byKey['k-shared']!.sharedWith).toEqual([])
})

// The shared view HMAC-rewrites keyIds, so participants could not be joined to
// usage anyway — and the names would leak identities the viewer never sees.
test('participants: shared view gets nothing', async () => {
  await repo.apiKeys.save(mkKey('k1', 'owned', 'owner'))
  await addUser('owner', 'Olive')
  const { body } = await participants({ userId: 'viewer', isViewingShared: true, ownerId: 'owner' })
  expect(body).toEqual([])
})

test('participants: an API-key caller gets nothing', async () => {
  await repo.apiKeys.save(mkKey('k1', 'owned', 'owner'))
  const { res, body } = await participants({ apiKeyId: 'k1' })
  expect(res.status).toBe(200)
  expect(body).toEqual([])
})

test('participants: a caller with no identity is unauthorized', async () => {
  await repo.apiKeys.save(mkKey('k1', 'owned', 'owner'))
  const { res, body } = await participants({})
  expect(res.status).toBe(401)
  expect(body).toEqual({ error: 'Unauthorized' })
})
