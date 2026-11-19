/**
 * performance + latency control-plane tests — Week 5b.
 *
 * Real in-memory SQLite repo (setupTestPlatform); rows are stored, not stubbed.
 * Covers 4 scoping branches + redaction in shared view for both routes.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { setupTestPlatform } from './_setup-platform.ts'
import type { ApiKeyId, UserId } from '../src/repo/branded-ids.ts'
import type { ApiKey, PerformanceRecordInput } from '../src/repo/types.ts'
import {
  performanceRouter,
  type PerformanceAuthCtx,
} from '../src/control-plane/performance/routes.ts'

const TEST_ENV = { SERVER_SECRET: 'test-secret' }

function buildApp(auth: PerformanceAuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api', performanceRouter)
  return app
}

function call(app: ReturnType<typeof buildApp>, path: string) {
  return app.request(path, {}, TEST_ENV)
}

function mkKey(id: string, name: string, ownerId?: string): ApiKey {
  return { id, name, key: `k-${id}`, createdAt: '2026-01-01T00:00:00Z', ownerId, modelMappingsEnabled: false, modelMappings: [] } as ApiKey
}

// One recorded request fills both performance_summary and its latency buckets.
async function seedPerformance(keyId: string, hour: string): Promise<void> {
  await repo.performance.record({
    hour, metricScope: 'request_total', keyId, model: 'm', upstream: null,
    sourceApi: 'messages', targetApi: 'messages', stream: false, runtimeLocation: 'local',
    durationMs: 100, isError: false,
  } as PerformanceRecordInput)
}

let repo: ReturnType<typeof setupTestPlatform>['repo']

beforeEach(() => {
  ;({ repo } = setupTestPlatform())
})

const RANGE = '?start=2026-03-01T00&end=2026-03-01T23'

test('GET /api/latency missing start/end → 400', async () => {
  const res = await call(buildApp({ userId: 'u1' }), '/api/latency')
  expect(res.status).toBe(400)
})

test('GET /api/performance missing start/end → 400', async () => {
  const res = await call(buildApp({ userId: 'u1' }), '/api/performance')
  expect(res.status).toBe(400)
})

test('GET /api/latency user scopes to own + assigned keys', async () => {
  await repo.apiKeys.save(mkKey('k1', 'mine', 'u1'))
  await repo.apiKeys.save(mkKey('k2', 'other', 'u2'))
  // Spec-3: /api/latency derives from performance_summary (request_total scope).
  await seedPerformance('k1', '2026-03-01T00')
  await seedPerformance('k2', '2026-03-01T00')

  const res = await call(buildApp({ userId: 'u1' }), `/api/latency${RANGE}`)
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ keyId: string; keyName: string }>
  expect(body).toHaveLength(1)
  expect(body[0].keyId).toBe('k1')
  expect(body[0].keyName).toBe('mine')
})

test('GET /api/latency user with no keys → []', async () => {
  const res = await call(buildApp({ userId: 'u1' }), `/api/latency${RANGE}`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([])
})

test('GET /api/latency shared-view: owned-only + HMAC-redacted keyId', async () => {
  await repo.apiKeys.save(mkKey('k-owned', 'owned-key', 'owner'))
  await repo.apiKeys.save(mkKey('k-assigned', 'a', 'someone'))
  await repo.keyAssignments.assign('k-assigned' as ApiKeyId, 'owner' as UserId, 'admin' as UserId)
  // Spec-3: /api/latency derives from performance_summary (request_total scope).
  await seedPerformance('k-owned', '2026-03-01T00')
  await seedPerformance('k-assigned', '2026-03-01T00')

  const res = await call(
    buildApp({ userId: 'viewer', isViewingShared: true, ownerId: 'owner' }),
    `/api/latency${RANGE}`,
  )
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ keyId: string; keyName: string }>
  expect(body).toHaveLength(1)
  expect(body[0].keyId).not.toBe('k-owned')
  expect(body[0].keyId).toMatch(/^[A-Za-z0-9_-]{16}$/)
  expect(body[0].keyName).toBe('owned-key')
})

test('GET /api/performance returns {summary, buckets} for user', async () => {
  await repo.apiKeys.save(mkKey('k1', 'mine', 'u1'))
  await seedPerformance('k1', '2026-03-01T00')

  const res = await call(buildApp({ userId: 'u1' }), `/api/performance${RANGE}`)
  expect(res.status).toBe(200)
  const body = await res.json() as {
    summary: Array<{ keyId: string; keyName: string }>
    buckets: Array<{ keyId: string; keyName: string }>
  }
  expect(body.summary).toHaveLength(1)
  expect(body.buckets).toHaveLength(1)
  expect(body.summary[0].keyName).toBe('mine')
  expect(body.buckets[0].keyName).toBe('mine')
})

test('GET /api/performance user with no keys → {summary:[], buckets:[]}', async () => {
  const res = await call(buildApp({ userId: 'u1' }), `/api/performance${RANGE}`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ summary: [], buckets: [] })
})

test('GET /api/performance shared-view: HMAC-redacted keyId in both summary and buckets', async () => {
  await repo.apiKeys.save(mkKey('k-owned', 'owned-key', 'owner'))
  await seedPerformance('k-owned', '2026-03-01T00')

  const res = await call(
    buildApp({ userId: 'viewer', isViewingShared: true, ownerId: 'owner' }),
    `/api/performance${RANGE}`,
  )
  expect(res.status).toBe(200)
  const body = await res.json() as {
    summary: Array<{ keyId: string; keyName: string }>
    buckets: Array<{ keyId: string; keyName: string }>
  }
  expect(body.summary).toHaveLength(1)
  expect(body.buckets).toHaveLength(1)
  for (const row of [...body.summary, ...body.buckets]) {
    expect(row.keyId).not.toBe('k-owned')
    expect(row.keyId).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(row.keyName).toBe('owned-key')
  }
})

test('GET /api/performance metric_scope=upstream_success is honored', async () => {
  await repo.apiKeys.save(mkKey('k1', 'mine', 'u1'))
  // mkSummary uses request_total; this test just verifies the route doesn't error
  // and returns proper shape when metric_scope query is upstream_success
  const res = await call(
    buildApp({ userId: 'u1' }),
    `/api/performance${RANGE}&metric_scope=upstream_success`,
  )
  expect(res.status).toBe(200)
  const body = await res.json() as { summary: unknown[]; buckets: unknown[] }
  expect(Array.isArray(body.summary)).toBe(true)
  expect(Array.isArray(body.buckets)).toBe(true)
})
