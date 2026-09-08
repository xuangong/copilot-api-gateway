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
import { getRepo } from '../../repo/index.ts'
import type {
  ApiKey,
  LatencyRecord,
  PerformanceMetricScope,
  PerformanceSummaryRecord,
} from '../../repo/types.ts'
import {
  redactForSharedView,
  getServerSecret,
  sharedKeyRef,
} from '../lib/redact-shared-view.ts'
import { deriveViewContext, getOwnedKeyIdsForScope } from '../lib/view-context.ts'
import type { ApiKeyId, UserId } from '../../repo/branded-ids.ts'

export interface PerformanceAuthCtx {
  authKind?: "apiKey" | "session" | "public"
  apiKeyId?: ApiKeyId
  isAdmin?: boolean
  userId?: UserId
  isViewingShared?: boolean
  ownerId?: UserId
}

type Vars = { auth: PerformanceAuthCtx }

/**
 * Spec-3 transition: legacy `latency` table is no longer written by chat-flow
 * (recordPerformance only fills performance_summary). Derive LatencyRecord[]
 * from PerformanceSummaryRecord[] so the dashboard /api/latency view keeps
 * working. Collapses (sourceApi,targetApi) sub-rows into one bucket per
 * (keyId, model, hour, runtimeLocation, stream).
 *
 * Field mapping (some are degraded — Spec-3 doesn't capture them):
 *   colo       ← runtimeLocation
 *   totalMs    ← Σ totalMsSum
 *   upstreamMs ← null (not captured)
 *   ttfbMs     ← null (not captured)
 *   tokenMiss  ← 0 (not captured)
 */
type DerivedLatencyRecord = Omit<LatencyRecord, "upstreamMs" | "ttfbMs"> & { upstreamMs: null; ttfbMs: null }

function summaryToLatencyRecords(rows: PerformanceSummaryRecord[]): DerivedLatencyRecord[] {
  const buckets = new Map<string, DerivedLatencyRecord>()
  for (const r of rows) {
    const key = `${r.keyId}|${r.model}|${r.hour}|${r.runtimeLocation}|${r.stream ? 1 : 0}`
    const existing = buckets.get(key)
    if (existing) {
      existing.requests += r.requests
      existing.totalMs += r.totalMsSum
    } else {
      buckets.set(key, {
        keyId: r.keyId,
        model: r.model,
        hour: r.hour,
        colo: r.runtimeLocation,
        stream: r.stream,
        requests: r.requests,
        totalMs: r.totalMsSum,
        upstreamMs: null,
        ttfbMs: null,
        tokenMiss: 0,
      })
    }
  }
  return [...buckets.values()]
}

async function getUserKeys(userId: UserId): Promise<ApiKey[]> {
  const repo = getRepo()
  const [ownKeys, assignments] = await Promise.all([
    repo.apiKeys.listByOwner(userId),
    repo.keyAssignments.listByUser(userId),
  ])
  const keyMap = new Map<string, ApiKey>(ownKeys.map((k) => [k.id, k]))
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
  const keyId = (c.req.query('key_id') || undefined) as ApiKeyId | undefined
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
    const perfResult = await repo.performance.query({ keyIds: ids as ApiKeyId[], start, end, metricScope: 'request_total' })
    const records = summaryToLatencyRecords(perfResult.summary)
    const nameMap = new Map<string, string>(ownedKeys.map((k) => [k.id, k.name]))
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

  let queryOpts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string }
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
  const perfResult = await repo.performance.query({ ...queryOpts, metricScope: 'request_total' })
  const records = summaryToLatencyRecords(perfResult.summary)
  const nameMap = new Map<string, string>(keys.map((k) => [k.id, k.name]))
  return c.json(
    records.map((r) => ({ ...r, keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8) })),
  )
})

performanceRouter.get('/performance', async (c) => {
  const auth = c.get('auth') ?? {}
  const keyId = (c.req.query('key_id') || undefined) as ApiKeyId | undefined
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
    const result = await repo.performance.query({ keyIds: ids as ApiKeyId[], start, end, metricScope })
    const nameMap = new Map<string, string>(ownedKeys.map((k) => [k.id, k.name]))
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
    keyId?: ApiKeyId
    keyIds?: ApiKeyId[]
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
  const nameMap = new Map<string, string>(keys.map((k) => [k.id, k.name]))
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

function validUtcHour(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(value)) return false
  const time = new Date(`${value}:00:00.000Z`)
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 13) === value
}

performanceRouter.get('/performance/metrics', async (c) => {
  const auth = c.get('auth') ?? {}
  const usingApiKey = auth.authKind === "apiKey"
  if (usingApiKey ? !auth.apiKeyId : !auth.isAdmin && !auth.userId) return c.json({ error: 'Authentication required' }, 401)
  if (usingApiKey && auth.isViewingShared) return c.json({ error: 'Invalid shared view' }, 403)
  const start = c.req.query('start') ?? ''
  const end = c.req.query('end') ?? ''
  if (!validUtcHour(start) || !validUtcHour(end) || start > end || Date.parse(`${end}:00Z`) - Date.parse(`${start}:00Z`) > 366 * 86400000) {
    return c.json({ error: 'start and end must be valid ordered UTC hours within 366 days (e.g. 2026-09-08T00)' }, 400)
  }
  const repo = getRepo()
  const view = await deriveViewContext(c, auth)
  if ("denied" in view) return c.json({ error: "Not authorized to view this user's observability data" }, 403)
  const ownerId = view.isViewingShared ? view.ownerId : undefined
  let keys: ApiKey[]
  if (usingApiKey && auth.apiKeyId) {
    const key = await repo.apiKeys.getById(auth.apiKeyId)
    if (!key) return c.json({ error: 'Authentication required' }, 401)
    keys = [key]
  } else if (ownerId) keys = await repo.apiKeys.listByOwner(ownerId)
  else if (auth.isAdmin) keys = await repo.apiKeys.list()
  else if (auth.userId) keys = await getUserKeys(auth.userId)
  else return c.json({ error: 'Authentication required' }, 401)
  const keyFilter = c.req.query('key_id')
  const secret = ownerId ? getEnvSecret(c) : ''
  if (keyFilter) keys = keys.filter(key => key.id === keyFilter || (ownerId && sharedKeyRef(ownerId, key.id, secret) === keyFilter))
  const result = await repo.performanceMetrics.query(!usingApiKey && auth.isAdmin && !ownerId
    ? { start, end, keyId: keyFilter as ApiKeyId | undefined }
    : { start, end, keyIds: keys.map(key => key.id) })
  const names = new Map(keys.map(key => [String(key.id), key.name]))
  return c.json({
    ...result,
    groups: result.groups.map(group => ({
      ...group,
      keyId: ownerId ? sharedKeyRef(ownerId, group.keyId, secret) : group.keyId,
      keyName: names.get(group.keyId) ?? 'Unknown key',
    })),
  })
})
