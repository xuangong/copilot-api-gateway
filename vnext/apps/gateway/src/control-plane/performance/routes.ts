/**
 * latency + performance control-plane router — Week 5b port of
 * src/routes/dashboard.ts (GET /latency, GET /performance).
 *
 * Same 4-branch scoping pattern as token-usage:
 *   admin / shared-view / user / fallback.
 * Shared view uses redactForSharedView('latency') for /latency and a manual
 * sharedKeyRef rewrite for /performance summary+buckets (no kind for it).
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../shared/repo/index.ts'
import type { ApiKey, PerformanceMetricScope } from '../../shared/repo/types.ts'
import {
  redactForSharedView,
  getServerSecret,
  sharedKeyRef,
} from '../../shared/lib/redact-shared-view.ts'
import { getOwnedKeyIdsForScope } from '../../shared/lib/view-context.ts'

export interface PerformanceAuthCtx {
  isAdmin?: boolean
  userId?: string
  isViewingShared?: boolean
  ownerId?: string
}

type Vars = { auth: PerformanceAuthCtx }

async function getUserKeys(userId: string): Promise<ApiKey[]> {
  const repo = getRepo()
  const [ownKeys, assignments] = await Promise.all([
    repo.apiKeys.listByOwner(userId),
    repo.keyAssignments.listByUser(userId),
  ])
  const keyMap = new Map(ownKeys.map((k) => [k.id, k]))
  if (assignments.length > 0) {
    const assignedKeys = await Promise.all(
      assignments.filter((a) => !keyMap.has(a.keyId)).map((a) => repo.apiKeys.getById(a.keyId)),
    )
    for (const k of assignedKeys) if (k) keyMap.set(k.id, k)
  }
  return [...keyMap.values()]
}

function getEnvSecret(c: { env: unknown }): string {
  return getServerSecret(c.env as Record<string, string | undefined>)
}

export const performanceRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

performanceRouter.get('/latency', async (c) => {
  const auth = c.get('auth') ?? {}
  const keyId = c.req.query('key_id') || undefined
  const start = c.req.query('start') ?? ''
  const end = c.req.query('end') ?? ''
  if (!start || !end) {
    return c.json({ error: 'start and end query parameters are required (e.g. 2026-03-09T00)' }, 400)
  }
  const repo = getRepo()

  if (auth.isViewingShared && auth.ownerId) {
    const ids = await getOwnedKeyIdsForScope(auth.ownerId)
    if (ids.length === 0) return c.json([])
    const ownedKeys = await repo.apiKeys.listByOwner(auth.ownerId)
    const records = await repo.latency.query({ keyIds: ids, start, end })
    const nameMap = new Map(ownedKeys.map((k) => [k.id, k.name]))
    const enriched = records.map((r) => ({
      ...r,
      keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
    }))
    return c.json(
      redactForSharedView({
        kind: 'latency',
        payload: enriched,
        ownerId: auth.ownerId,
        secret: getEnvSecret(c),
      }),
    )
  }

  let queryOpts: { keyId?: string; keyIds?: string[]; start: string; end: string }
  let keys: ApiKey[]
  if (auth.isAdmin) {
    queryOpts = { keyId, start, end }
    keys = await repo.apiKeys.list()
  } else if (auth.userId) {
    const userKeys = await getUserKeys(auth.userId)
    if (userKeys.length === 0) return c.json([])
    queryOpts = { keyIds: userKeys.map((k) => k.id), start, end }
    keys = userKeys
  } else {
    queryOpts = { keyId, start, end }
    keys = await repo.apiKeys.list()
  }
  const records = await repo.latency.query(queryOpts)
  const nameMap = new Map(keys.map((k) => [k.id, k.name]))
  return c.json(
    records.map((r) => ({ ...r, keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8) })),
  )
})

performanceRouter.get('/performance', async (c) => {
  const auth = c.get('auth') ?? {}
  const keyId = c.req.query('key_id') || undefined
  const start = c.req.query('start') ?? ''
  const end = c.req.query('end') ?? ''
  const metricScopeRaw = c.req.query('metric_scope') ?? 'request_total'
  const metricScope: PerformanceMetricScope =
    metricScopeRaw === 'upstream_success' ? 'upstream_success' : 'request_total'

  if (!start || !end) {
    return c.json({ error: 'start and end query parameters are required (e.g. 2026-03-09T00)' }, 400)
  }
  const repo = getRepo()

  if (auth.isViewingShared && auth.ownerId) {
    const ids = await getOwnedKeyIdsForScope(auth.ownerId)
    if (ids.length === 0) return c.json({ summary: [], buckets: [] })
    const ownedKeys = await repo.apiKeys.listByOwner(auth.ownerId)
    const result = await repo.performance.query({ keyIds: ids, start, end, metricScope })
    const nameMap = new Map(ownedKeys.map((k) => [k.id, k.name]))
    const secret = getEnvSecret(c)
    return c.json({
      summary: result.summary.map((r) => ({
        ...r,
        keyId: sharedKeyRef(auth.ownerId!, r.keyId, secret),
        keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
      })),
      buckets: result.buckets.map((r) => ({
        ...r,
        keyId: sharedKeyRef(auth.ownerId!, r.keyId, secret),
        keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
      })),
    })
  }

  let queryOpts: {
    keyId?: string
    keyIds?: string[]
    start: string
    end: string
    metricScope: PerformanceMetricScope
  }
  let keys: ApiKey[]
  if (auth.isAdmin) {
    queryOpts = { keyId, start, end, metricScope }
    keys = await repo.apiKeys.list()
  } else if (auth.userId) {
    const userKeys = await getUserKeys(auth.userId)
    if (userKeys.length === 0) return c.json({ summary: [], buckets: [] })
    queryOpts = { keyIds: userKeys.map((k) => k.id), start, end, metricScope }
    keys = userKeys
  } else {
    queryOpts = { keyId, start, end, metricScope }
    keys = await repo.apiKeys.list()
  }

  const result = await repo.performance.query(queryOpts)
  const nameMap = new Map(keys.map((k) => [k.id, k.name]))
  return c.json({
    summary: result.summary.map((r) => ({
      ...r,
      keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
    })),
    buckets: result.buckets.map((r) => ({
      ...r,
      keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
    })),
  })
})
