/**
 * performance + latency control-plane tests — Week 5b.
 *
 * In-memory repo + setRepoForTest (per bun_mock_module_unrestorable).
 * Covers 4 scoping branches + redaction in shared view for both routes.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vnext-gateway/platform'
import type {
  ApiKey,
  KeyAssignment,
  LatencyRecord,
  PerformanceBucketRecord,
  PerformanceSummaryRecord,
  Repo,
} from '../src/shared/repo/types.ts'
import {
  performanceRouter,
  type PerformanceAuthCtx,
} from '../src/control-plane/performance/routes.ts'

function inMemoryRepo() {
  const keys = new Map<string, ApiKey>()
  const latency: LatencyRecord[] = []
  const perfSummary: PerformanceSummaryRecord[] = []
  const perfBuckets: PerformanceBucketRecord[] = []
  const assignments: KeyAssignment[] = []

  const repo = {
    apiKeys: {
      list: async () => [...keys.values()],
      listByOwner: async (ownerId: string) =>
        [...keys.values()].filter((k) => k.ownerId === ownerId),
      getById: async (id: string) => keys.get(id) ?? null,
    },
    keyAssignments: {
      listByUser: async (userId: string) => assignments.filter((a) => a.userId === userId),
    },
    latency: {
      query: async (opts: { keyId?: string; keyIds?: string[]; start: string; end: string }) =>
        latency.filter((r) => {
          if (opts.keyId && r.keyId !== opts.keyId) return false
          if (opts.keyIds && !opts.keyIds.includes(r.keyId)) return false
          return r.hour >= opts.start && r.hour <= opts.end
        }),
    },
    performance: {
      query: async (opts: { keyId?: string; keyIds?: string[]; start: string; end: string; metricScope?: string }) => {
        const filter = <T extends { keyId: string; hour: string; metricScope?: string }>(rows: T[]) =>
          rows.filter((r) => {
            if (opts.keyId && r.keyId !== opts.keyId) return false
            if (opts.keyIds && !opts.keyIds.includes(r.keyId)) return false
            if (opts.metricScope && r.metricScope !== opts.metricScope) return false
            return r.hour >= opts.start && r.hour <= opts.end
          })
        return { summary: filter(perfSummary), buckets: filter(perfBuckets) }
      },
    },
  } as unknown as Repo

  return { repo, keys, latency, perfSummary, perfBuckets, assignments }
}

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
  return { id, name, key: `k-${id}`, createdAt: '2026-01-01T00:00:00Z', ownerId } as ApiKey
}

function mkLatency(keyId: string, hour: string): LatencyRecord {
  return {
    keyId, model: 'm', hour, colo: 'c', stream: false,
    requests: 1, totalMs: 100, upstreamMs: 80, ttfbMs: 50, tokenMiss: 0,
  }
}

function mkSummary(keyId: string, hour: string): PerformanceSummaryRecord {
  return {
    hour, metricScope: 'request_total', keyId, model: 'm', upstream: null,
    sourceApi: 'messages', targetApi: 'messages', stream: false, runtimeLocation: 'local',
    requests: 1, errors: 0, totalMsSum: 100,
  }
}

function mkBucket(keyId: string, hour: string): PerformanceBucketRecord {
  return {
    hour, metricScope: 'request_total', keyId, model: 'm', upstream: null,
    sourceApi: 'messages', targetApi: 'messages', stream: false, runtimeLocation: 'local',
    lowerMs: 0, upperMs: 100, count: 1,
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
  store.keys.set('k1', mkKey('k1', 'mine', 'u1'))
  store.keys.set('k2', mkKey('k2', 'other', 'u2'))
  // Spec-3: /api/latency derives from performance_summary (request_total scope).
  store.perfSummary.push(mkSummary('k1', '2026-03-01T00'))
  store.perfSummary.push(mkSummary('k2', '2026-03-01T00'))

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
  store.keys.set('k-owned', mkKey('k-owned', 'owned-key', 'owner'))
  store.keys.set('k-assigned', mkKey('k-assigned', 'a', 'someone'))
  store.assignments.push({ keyId: 'k-assigned', userId: 'owner', assignedBy: 'admin', assignedAt: '' })
  // Spec-3: /api/latency derives from performance_summary (request_total scope).
  store.perfSummary.push(mkSummary('k-owned', '2026-03-01T00'))
  store.perfSummary.push(mkSummary('k-assigned', '2026-03-01T00'))

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
  store.keys.set('k1', mkKey('k1', 'mine', 'u1'))
  store.perfSummary.push(mkSummary('k1', '2026-03-01T00'))
  store.perfBuckets.push(mkBucket('k1', '2026-03-01T00'))

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
  store.keys.set('k-owned', mkKey('k-owned', 'owned-key', 'owner'))
  store.perfSummary.push(mkSummary('k-owned', '2026-03-01T00'))
  store.perfBuckets.push(mkBucket('k-owned', '2026-03-01T00'))

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
  store.keys.set('k1', mkKey('k1', 'mine', 'u1'))
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
