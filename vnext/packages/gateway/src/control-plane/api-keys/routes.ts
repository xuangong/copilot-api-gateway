/**
 * API-keys control-plane router — Week 5a-impl.
 *
 * Ported 1:1 from old src/routes/api-keys.ts (Elysia → Hono). Behavior, JSON
 * shapes, status codes, and ownership rules match the old project verbatim
 * so the dashboard sees no diff.
 *
 * Auth model: handlers read `c.get('auth')` (set by an upstream middleware,
 * which is not yet ported in vnext). Tests inject auth by mounting a small
 * pre-middleware that calls `c.set('auth', {...})`.
 *
 * Deferred from old code:
 *   - `~/services/web-search/resolver.invalidateResolverCache` → no-op TODO
 *     until web-search service lands.
 *   - `~/services/web-search/resolver.isKeyVisibleTo` → inlined narrowed
 *     equivalent: admin OR same owner OR key-assignment grant.
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import {
  createApiKey,
  listApiKeys,
  listApiKeysByOwner,
  getApiKeyById,
  rotateApiKey,
  deleteApiKey,
  type ApiKey,
} from '../../shared/lib/api-keys.ts'
import { getRepo } from '../../shared/repo/index.ts'

export interface AuthCtx {
  isAdmin?: boolean
  isUser?: boolean
  apiKeyId?: string
  userId?: string
}

type Vars = { auth: AuthCtx }

function maskKey(key?: string): string | null {
  if (!key) return null
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

interface RefDescriptor {
  id: string
  name: string | null
  owner_id: string | null
  broken: true | undefined
}

function refDescriptor(refId: string, sourceMap: Map<string, ApiKey>): RefDescriptor {
  const src = sourceMap.get(refId)
  if (!src) return { id: refId, name: null, owner_id: null, broken: true }
  return { id: refId, name: src.name, owner_id: src.ownerId ?? null, broken: undefined }
}

async function loadSourceMapForKey(k: ApiKey): Promise<Map<string, ApiKey>> {
  const map = new Map<string, ApiKey>()
  for (const refId of [k.webSearchLangsearchRef, k.webSearchTavilyRef, k.webSearchMsGroundingRef]) {
    if (refId) {
      const s = await getApiKeyById(refId)
      if (s) map.set(refId, s)
    }
  }
  return map
}

function keyToJson(k: ApiKey, ownerName?: string, isOwner?: boolean, sourceMap?: Map<string, ApiKey>) {
  const map = sourceMap ?? new Map<string, ApiKey>()
  const langsearchRef = k.webSearchLangsearchRef ? refDescriptor(k.webSearchLangsearchRef, map) : null
  const tavilyRef = k.webSearchTavilyRef ? refDescriptor(k.webSearchTavilyRef, map) : null
  const msGroundingRef = k.webSearchMsGroundingRef ? refDescriptor(k.webSearchMsGroundingRef, map) : null
  return {
    id: k.id, name: k.name, key: k.key, created_at: k.createdAt,
    last_used_at: k.lastUsedAt ?? null, owner_id: k.ownerId ?? null,
    owner_name: ownerName ?? null, is_owner: isOwner ?? true,
    quota_requests_per_day: k.quotaRequestsPerDay ?? null,
    quota_tokens_per_day: k.quotaTokensPerDay ?? null,
    web_search_enabled: k.webSearchEnabled ?? false,
    web_search_langsearch_key: langsearchRef ? null : maskKey(k.webSearchLangsearchKey),
    web_search_langsearch_ref: langsearchRef,
    web_search_tavily_key: tavilyRef ? null : maskKey(k.webSearchTavilyKey),
    web_search_tavily_ref: tavilyRef,
    web_search_ms_grounding_key: msGroundingRef ? null : maskKey(k.webSearchMsGroundingKey),
    web_search_ms_grounding_ref: msGroundingRef,
    web_search_priority: k.webSearchPriority ?? null,
  }
}

async function checkOwnership(keyId: string, ctx: AuthCtx): Promise<boolean> {
  if (ctx.isAdmin) return true
  if (!ctx.userId) return false
  const key = await getApiKeyById(keyId)
  return key?.ownerId === ctx.userId
}

/**
 * Narrowed substitute for old `isKeyVisibleTo` (web-search resolver). Visible
 * iff admin OR same owner OR explicit key-assignment grant. Drops the
 * observability-share branch from the old impl — that path is only needed
 * when web-search resolver is fully ported.
 */
async function checkRefVisible(refSourceId: string, ctx: AuthCtx): Promise<{ ok: boolean; reason?: string; status: number }> {
  const src = await getApiKeyById(refSourceId)
  if (!src) return { ok: false, reason: 'Source key not found', status: 404 }
  if (ctx.isAdmin) return { ok: true, status: 200 }
  if (!ctx.userId) return { ok: false, reason: 'Forbidden', status: 403 }
  if (src.ownerId === ctx.userId) return { ok: true, status: 200 }
  const grants = await getRepo().keyAssignments.listByUser(ctx.userId)
  if (grants.some((g) => g.keyId === src.id)) return { ok: true, status: 200 }
  return { ok: false, reason: 'Source key not visible', status: 400 }
}

function invalidateResolverCache(_keyId: string): void {
  // TODO(week 4b-3): wire to web-search resolver once it lands.
}

export const apiKeysRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

apiKeysRouter.get('/_health', (c) => c.json({ scope: 'control-plane:api-keys', status: 'scaffold' }))

// GET / — list API keys (admin: all + assignees; user: own + assigned; legacy: own only)
apiKeysRouter.get('/', async (c) => {
  const auth = c.get('auth') ?? {}
  const { isAdmin, isUser, apiKeyId, userId } = auth
  const repo = getRepo()

  if (isAdmin) {
    const keys = await listApiKeys()
    const ownerIds = [...new Set(keys.map((k) => k.ownerId).filter(Boolean))] as string[]
    const ownerMap = new Map<string, string>()
    await Promise.all(ownerIds.map(async (id) => {
      const user = await repo.users.getById(id)
      if (user) ownerMap.set(id, user.name)
    }))
    const allAssignments = await Promise.all(keys.map((k) => repo.keyAssignments.listByKey(k.id)))
    const assigneeUserIds = new Set<string>()
    for (const aList of allAssignments) for (const a of aList) assigneeUserIds.add(a.userId)
    const assigneeNameMap = new Map<string, string>()
    if (assigneeUserIds.size > 0) {
      const assigneeUsers = await Promise.all([...assigneeUserIds].map((id) => repo.users.getById(id)))
      for (const u of assigneeUsers) if (u) assigneeNameMap.set(u.id, u.name)
    }
    const refIds = new Set<string>()
    for (const k of keys) {
      if (k.webSearchLangsearchRef) refIds.add(k.webSearchLangsearchRef)
      if (k.webSearchTavilyRef) refIds.add(k.webSearchTavilyRef)
      if (k.webSearchMsGroundingRef) refIds.add(k.webSearchMsGroundingRef)
    }
    const sourceMap = new Map<string, ApiKey>()
    await Promise.all([...refIds].map(async (id) => {
      const src = await getApiKeyById(id)
      if (src) sourceMap.set(id, src)
    }))
    return c.json(keys.map((k, i) => {
      const json = keyToJson(k, k.ownerId ? ownerMap.get(k.ownerId) : undefined, true, sourceMap)
      const assignees = allAssignments[i]!.map((a) => ({
        user_id: a.userId,
        user_name: assigneeNameMap.get(a.userId) ?? null,
      }))
      return { ...json, assignees }
    }))
  }

  if (isUser && userId) {
    const [ownKeys, assignments] = await Promise.all([
      listApiKeysByOwner(userId),
      repo.keyAssignments.listByUser(userId),
    ])
    const ownKeyAssignments = await Promise.all(ownKeys.map((k) => repo.keyAssignments.listByKey(k.id)))
    const assigneeUserIds = new Set<string>()
    for (const aList of ownKeyAssignments) for (const a of aList) assigneeUserIds.add(a.userId)
    const assigneeNameMap = new Map<string, string>()
    if (assigneeUserIds.size > 0) {
      const assigneeUsers = await Promise.all([...assigneeUserIds].map((id) => repo.users.getById(id)))
      for (const u of assigneeUsers) if (u) assigneeNameMap.set(u.id, u.name)
    }
    const ownRefIds = new Set<string>()
    for (const k of ownKeys) {
      if (k.webSearchLangsearchRef) ownRefIds.add(k.webSearchLangsearchRef)
      if (k.webSearchTavilyRef) ownRefIds.add(k.webSearchTavilyRef)
      if (k.webSearchMsGroundingRef) ownRefIds.add(k.webSearchMsGroundingRef)
    }
    const ownSourceMap = new Map<string, ApiKey>()
    await Promise.all([...ownRefIds].map(async (id) => {
      const src = await getApiKeyById(id)
      if (src) ownSourceMap.set(id, src)
    }))
    const result = ownKeys.map((k, i) => {
      const json = keyToJson(k, undefined, true, ownSourceMap)
      const assignees = ownKeyAssignments[i]!.map((a) => ({
        user_id: a.userId,
        user_name: assigneeNameMap.get(a.userId) ?? null,
      }))
      return { ...json, assignees }
    })

    if (assignments.length > 0) {
      const assignedKeys = await Promise.all(assignments.map((a) => getApiKeyById(a.keyId)))
      const ownerIds = [...new Set(assignedKeys.filter(Boolean).map((k) => k!.ownerId).filter(Boolean))] as string[]
      const ownerMap = new Map<string, string>()
      await Promise.all(ownerIds.map(async (id) => {
        const user = await repo.users.getById(id)
        if (user) ownerMap.set(id, user.name)
      }))
      const assignedRefIds = new Set<string>()
      for (const k of assignedKeys) {
        if (!k) continue
        if (k.webSearchLangsearchRef) assignedRefIds.add(k.webSearchLangsearchRef)
        if (k.webSearchTavilyRef) assignedRefIds.add(k.webSearchTavilyRef)
        if (k.webSearchMsGroundingRef) assignedRefIds.add(k.webSearchMsGroundingRef)
      }
      const assignedSourceMap = new Map<string, ApiKey>()
      await Promise.all([...assignedRefIds].map(async (id) => {
        const src = await getApiKeyById(id)
        if (src) assignedSourceMap.set(id, src)
      }))
      for (const k of assignedKeys) {
        if (k && !ownKeys.some((o) => o.id === k.id)) {
          result.push({ ...keyToJson(k, k.ownerId ? ownerMap.get(k.ownerId) : undefined, false, assignedSourceMap), assignees: [] })
        }
      }
    }
    return c.json(result)
  }

  if (apiKeyId) {
    const key = await getApiKeyById(apiKeyId)
    if (!key) return c.json([])
    const sourceMap = await loadSourceMapForKey(key)
    return c.json([keyToJson(key, undefined, true, sourceMap)])
  }

  return c.json([])
})

// POST / — create
apiKeysRouter.post('/', async (c) => {
  const auth = c.get('auth') ?? {}
  const body = await c.req.json().catch(() => ({})) as { name?: string }
  const { name } = body
  if (!name || typeof name !== 'string') {
    return c.json({ error: 'name is required' }, 400)
  }
  const ownerId = auth.isUser && auth.userId ? auth.userId : undefined
  const key = await createApiKey(name, ownerId)
  return c.json(keyToJson(key, undefined, true, new Map()))
})

// GET /:id
apiKeysRouter.get('/:id', async (c) => {
  const auth = c.get('auth') ?? {}
  const id = c.req.param('id')
  const key = await getApiKeyById(id)
  if (!key) return c.json({ error: 'Key not found' }, 404)
  if (!auth.isAdmin && key.ownerId !== auth.userId) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const sourceMap = await loadSourceMapForKey(key)
  return c.json(keyToJson(key, undefined, true, sourceMap))
})

// PATCH /:id — rename + quota + web_search (XOR literal vs ref)
apiKeysRouter.patch('/:id', async (c) => {
  const auth = c.get('auth') ?? {}
  const id = c.req.param('id')
  if (!(await checkOwnership(id, auth))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const body = await c.req.json().catch(() => ({})) as {
    name?: string
    quota_requests_per_day?: number | null
    quota_tokens_per_day?: number | null
    web_search_enabled?: boolean
    web_search_langsearch_key?: string | null
    web_search_tavily_key?: string | null
    web_search_ms_grounding_key?: string | null
    web_search_priority?: string[] | null
    web_search_langsearch_ref?: string | null
    web_search_tavily_ref?: string | null
    web_search_ms_grounding_ref?: string | null
  }
  const existing = await getApiKeyById(id)
  if (!existing) return c.json({ error: 'Key not found' }, 404)
  const updated: ApiKey = { ...existing }
  if (body.name !== undefined) {
    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'name must be a non-empty string' }, 400)
    }
    updated.name = body.name
  }
  if (body.quota_requests_per_day !== undefined) {
    updated.quotaRequestsPerDay = body.quota_requests_per_day === null ? undefined : body.quota_requests_per_day
  }
  if (body.quota_tokens_per_day !== undefined) {
    updated.quotaTokensPerDay = body.quota_tokens_per_day === null ? undefined : body.quota_tokens_per_day
  }
  if (body.web_search_enabled !== undefined) {
    updated.webSearchEnabled = body.web_search_enabled
  }

  const pairs: Array<[string, unknown, unknown, keyof ApiKey, keyof ApiKey]> = [
    ['langsearch', body.web_search_langsearch_key, body.web_search_langsearch_ref, 'webSearchLangsearchKey', 'webSearchLangsearchRef'],
    ['tavily', body.web_search_tavily_key, body.web_search_tavily_ref, 'webSearchTavilyKey', 'webSearchTavilyRef'],
    ['ms_grounding', body.web_search_ms_grounding_key, body.web_search_ms_grounding_ref, 'webSearchMsGroundingKey', 'webSearchMsGroundingRef'],
  ]
  const mutableUpdated = updated as unknown as Record<string, unknown>
  for (const [engineLabel, literalVal, refVal, literalField, refField] of pairs) {
    const literalProvided = literalVal !== undefined && literalVal !== null && literalVal !== ''
    const refProvided = refVal !== undefined && refVal !== null && refVal !== ''
    if (literalProvided && refProvided) {
      return c.json({ error: `Cannot set both web_search_${engineLabel}_key and web_search_${engineLabel}_ref` }, 400)
    }
    if (refProvided) {
      const check = await checkRefVisible(refVal as string, auth)
      if (!check.ok) return c.json({ error: check.reason }, check.status as 400 | 403 | 404)
      mutableUpdated[refField as string] = refVal
      mutableUpdated[literalField as string] = undefined
    } else if (refVal === null) {
      mutableUpdated[refField as string] = undefined
    }
    if (literalProvided) {
      mutableUpdated[literalField as string] = literalVal
      mutableUpdated[refField as string] = undefined
    } else if (literalVal === null) {
      mutableUpdated[literalField as string] = undefined
    }
  }
  if (body.web_search_priority !== undefined) {
    updated.webSearchPriority = body.web_search_priority === null ? undefined : body.web_search_priority
  }

  await getRepo().apiKeys.save(updated)
  invalidateResolverCache(updated.id)
  const sourceMap = await loadSourceMapForKey(updated)
  return c.json(keyToJson(updated, undefined, true, sourceMap))
})

// POST /:id/rotate
apiKeysRouter.post('/:id/rotate', async (c) => {
  const auth = c.get('auth') ?? {}
  const id = c.req.param('id')
  if (!(await checkOwnership(id, auth))) return c.json({ error: 'Forbidden' }, 403)
  const key = await rotateApiKey(id)
  if (!key) return c.json({ error: 'Key not found' }, 404)
  const sourceMap = await loadSourceMapForKey(key)
  return c.json(keyToJson(key, undefined, true, sourceMap))
})

// DELETE /:id
apiKeysRouter.delete('/:id', async (c) => {
  const auth = c.get('auth') ?? {}
  const id = c.req.param('id')
  if (!(await checkOwnership(id, auth))) return c.json({ error: 'Forbidden' }, 403)
  const deleted = await deleteApiKey(id)
  if (!deleted) return c.json({ error: 'Key not found' }, 404)
  await getRepo().keyAssignments.deleteByKey(id)
  return c.json({ ok: true })
})

// GET /:id/web-search-usage
apiKeysRouter.get('/:id/web-search-usage', async (c) => {
  const auth = c.get('auth') ?? {}
  const id = c.req.param('id')
  if (!(await checkOwnership(id, auth))) return c.json({ error: 'Forbidden' }, 403)
  const rangeRaw = c.req.query('range') ?? '1d'
  const days = rangeRaw === '30d' ? 30 : rangeRaw === '7d' ? 7 : 1
  const now = new Date()
  const tomorrowStart = new Date(now.getTime() + 86400000).toISOString().slice(0, 10) + 'T00'
  const startDate = new Date(now.getTime() - (days - 1) * 86400000)
  const todayStart = startDate.toISOString().slice(0, 10) + 'T00'
  const records = await getRepo().webSearchUsage.query({ keyId: id, start: todayStart, end: tomorrowStart })
  let searches = 0, successes = 0, failures = 0
  for (const r of records) {
    searches += r.searches
    successes += r.successes
    failures += r.failures
  }
  const engineRecords = await getRepo().webSearchEngineUsage.query({ keyId: id, start: todayStart, end: tomorrowStart })
  const engineMap = new Map<string, { engineId: string; attempts: number; successes: number; failures: number; emptyResults: number; totalResults: number; successDurationMs: number; failureDurationMs: number }>()
  for (const r of engineRecords) {
    const cur = engineMap.get(r.engineId) ?? { engineId: r.engineId, attempts: 0, successes: 0, failures: 0, emptyResults: 0, totalResults: 0, successDurationMs: 0, failureDurationMs: 0 }
    cur.attempts += r.attempts
    cur.successes += r.successes
    cur.failures += r.failures
    cur.emptyResults += r.emptyResults
    cur.totalResults += r.totalResults
    cur.successDurationMs += r.successDurationMs
    cur.failureDurationMs += r.failureDurationMs
    engineMap.set(r.engineId, cur)
  }
  const engines = Array.from(engineMap.values()).map((e) => ({
    ...e,
    avgSuccessMs: Math.round(e.successDurationMs / Math.max(e.successes, 1)),
    avgFailureMs: Math.round(e.failureDurationMs / Math.max(e.failures, 1)),
  }))
  return c.json({ range: `${days}d`, days, searches, successes, failures, records, engines })
})

// POST /:id/assign
apiKeysRouter.post('/:id/assign', async (c) => {
  const auth = c.get('auth') ?? {}
  const id = c.req.param('id')
  const key = await getApiKeyById(id)
  if (!key) return c.json({ error: 'Key not found' }, 404)
  const isOwner = !!auth.userId && key.ownerId === auth.userId
  if (!auth.isAdmin && !isOwner) return c.json({ error: 'Forbidden' }, 403)
  const body = await c.req.json().catch(() => ({})) as { user_id?: string; email?: string }
  const { user_id, email } = body
  if (!user_id && !email) return c.json({ error: 'user_id or email is required' }, 400)
  const repo = getRepo()
  let targetUser = null as Awaited<ReturnType<typeof repo.users.getById>>
  if (user_id) {
    targetUser = await repo.users.getById(user_id)
    if (!targetUser) return c.json({ error: 'User not found' }, 404)
  } else if (email) {
    targetUser = await repo.users.findByEmail(email.trim().toLowerCase())
    if (!targetUser) return c.json({ error: 'No user with that email' }, 404)
  }
  if (!targetUser) return c.json({ error: 'User not found' }, 404)
  if (targetUser.id === key.ownerId) return c.json({ error: 'Cannot share key with yourself' }, 400)
  const existing = await repo.keyAssignments.listByKey(id)
  if (existing.some((a) => a.userId === targetUser!.id)) return c.json({ error: 'Already shared with this user' }, 409)
  await repo.keyAssignments.assign(id, targetUser.id, auth.userId || 'admin')
  return c.json({ ok: true })
})

// DELETE /:id/assign/:userId
apiKeysRouter.delete('/:id/assign/:userId', async (c) => {
  const auth = c.get('auth') ?? {}
  const id = c.req.param('id')
  const userIdParam = c.req.param('userId')
  const key = await getApiKeyById(id)
  if (!key) return c.json({ error: 'Key not found' }, 404)
  const isOwner = !!auth.userId && key.ownerId === auth.userId
  if (!auth.isAdmin && !isOwner) return c.json({ error: 'Forbidden' }, 403)
  await getRepo().keyAssignments.unassign(id, userIdParam)
  return c.json({ ok: true })
})

// GET /:id/assignments
apiKeysRouter.get('/:id/assignments', async (c) => {
  const auth = c.get('auth') ?? {}
  const id = c.req.param('id')
  if (!auth.isAdmin) {
    if (!auth.userId) return c.json({ error: 'Forbidden' }, 403)
    const key = await getApiKeyById(id)
    if (!key || key.ownerId !== auth.userId) return c.json({ error: 'Forbidden' }, 403)
  }
  const repo = getRepo()
  const assignments = await repo.keyAssignments.listByKey(id)
  const users = await Promise.all(assignments.map((a) => repo.users.getById(a.userId)))
  return c.json(assignments.map((a, i) => ({
    key_id: a.keyId,
    user_id: a.userId,
    user_name: users[i]?.name ?? null,
    assigned_by: a.assignedBy,
    assigned_at: a.assignedAt,
  })))
})

// POST /:id/copy-web-search-from/:sourceId
apiKeysRouter.post('/:id/copy-web-search-from/:sourceId', async (c) => {
  const auth = c.get('auth') ?? {}
  const id = c.req.param('id')
  const sourceId = c.req.param('sourceId')
  if (!(await checkOwnership(id, auth))) return c.json({ error: 'Forbidden' }, 403)
  if (!(await checkOwnership(sourceId, auth))) return c.json({ error: 'Forbidden: no access to source key' }, 403)
  const target = await getApiKeyById(id)
  const source = await getApiKeyById(sourceId)
  if (!target || !source) return c.json({ error: 'Key not found' }, 404)
  const updated: ApiKey = {
    ...target,
    webSearchEnabled: source.webSearchEnabled,
    webSearchPriority: source.webSearchPriority,
    webSearchLangsearchKey: undefined,
    webSearchLangsearchRef: source.webSearchLangsearchKey ? source.id : undefined,
    webSearchTavilyKey: undefined,
    webSearchTavilyRef: source.webSearchTavilyKey ? source.id : undefined,
    webSearchMsGroundingKey: undefined,
    webSearchMsGroundingRef: source.webSearchMsGroundingKey ? source.id : undefined,
  }
  await getRepo().apiKeys.save(updated)
  invalidateResolverCache(updated.id)
  const sourceMap = await loadSourceMapForKey(updated)
  return c.json(keyToJson(updated, undefined, true, sourceMap))
})
