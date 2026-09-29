import { validateUsageOverview, type UsageOverviewQuery } from "../../repo/usage-overview"
import { deriveViewContext } from "../lib/view-context"
import { sharedKeyRef } from "../lib/redact-shared-view"
/**
 * token-usage control-plane router — Week 5b port of
 * src/routes/dashboard.ts (GET /token-usage).
 *
 * 4-branch scoping:
 *   - admin           → all keys + enrich with ownerId/ownerName
 *   - shared view     → owned-only keys for ownerId + HMAC-redact keyIds
 *   - API key         → authenticated key only
 *   - user (session)  → owned + assigned keys
 *
 * Cost is summed from each row's per-dimension `cost` snapshot (frozen at
 * write time) via `aggregateUsageForDisplay`; the global pricing table is
 * never consulted at read time, so historical cost is stable when pricing
 * later changes. See aggregate.ts for the math.
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../repo/index.ts'
import type { UsageKeyMetadata } from '../../repo/types.ts'
import { aggregateUsageForDisplay, type DisplayUsageRecord } from './aggregate.ts'
import {
  redactForSharedView,
  getServerSecret,
} from '../lib/redact-shared-view.ts'
import type { ApiKeyId, UserId } from '../../repo/branded-ids.ts'

export interface TokenUsageAuthCtx {
  authKind?: "public" | "session" | "apiKey"
  isAdmin?: boolean
  userId?: UserId
  apiKeyId?: ApiKeyId
  isViewingShared?: boolean
  ownerId?: UserId
}

type Vars = { auth: TokenUsageAuthCtx }

async function getUserKeys(userId: UserId): Promise<UsageKeyMetadata[]> {
  const repo = getRepo()
  const [ownKeys, assignments] = await Promise.all([
    repo.apiKeys.listByOwner(userId),
    repo.keyAssignments.listByUser(userId),
  ])
  // Preserve own-first and assignment iteration order, including deleted targets.
  const ids = [...new Set([...ownKeys.map(k => k.id), ...assignments.map(a => a.keyId)])]
  if (ids.length === 0) return []
  const metadata = new Map((await repo.usage.queryKeyMetadata(ids)).map(k => [k.keyId, k]))
  return ids.flatMap(id => {
    const key = metadata.get(id)
    return key ? [key] : []
  })
}

function enrichWithKeyName(
  rows: DisplayUsageRecord[],
  nameMap: Map<string, string>,
): Array<DisplayUsageRecord & { keyName: string }> {
  return rows.map((r) => ({
    ...r,
    keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
  }))
}

export const tokenUsageRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

/**
 * GET /token-usage/participants — who can use each key in scope.
 *
 * The Usage tab derived its user list from each usage row's owner, so a key
 * shared through `key_assignments` looked like it belonged to its owner alone.
 * This supplies the missing half.
 *
 * Deliberately not GET /api/keys: that returns `key: k.key`, the plaintext API
 * key, which the Usage tab has no use for. And deliberately not folded into
 * the usage rows: those are per (key, model, client, hour), so a repeated
 * assignee array would balloon a 30-day response.
 *
 * Registered before '/token-usage' only for readability — Hono matches the
 * literal path either way.
 */
tokenUsageRouter.get('/token-usage/participants', async (c) => {
  const auth = c.get('auth') ?? {}
  const repo = getRepo()

  // The shared view HMAC-rewrites keyIds (see redact-shared-view.ts), so these
  // rows could not be joined to its usage anyway — and the names would expose
  // people the viewer is not otherwise shown. API-key callers do not have a
  // user roster scope.
  if (!auth.isAdmin && !auth.userId && !auth.apiKeyId) return c.json({ error: 'Unauthorized' }, 401)
  if (auth.isViewingShared || auth.apiKeyId) return c.json([])

  const keys = auth.isAdmin
    ? await repo.usage.queryKeyMetadata()
    : auth.userId ? await getUserKeys(auth.userId) : []
  const visibleIds = keys.filter(k => auth.isAdmin || k.ownerId === auth.userId).map(k => k.keyId)
  const assignments = visibleIds.length ? await repo.usage.queryAssigneeMetadata(visibleIds) : []
  const sharedWith = new Map<ApiKeyId, Array<{ id: UserId; name: string }>>()
  for (const assignment of assignments) {
    const list = sharedWith.get(assignment.keyId) ?? []
    list.push({ id: assignment.userId, name: assignment.name ?? assignment.userId.slice(0, 8) })
    sharedWith.set(assignment.keyId, list)
  }
  return c.json(keys.map(k => ({
    keyId: k.keyId,
    ownerId: k.ownerId,
    ownerName: k.ownerId ? k.ownerName : null,
    sharedWith: sharedWith.get(k.keyId) ?? [],
  })))
})

tokenUsageRouter.get("/token-usage/overview", async (c) => {
  const auth = c.get("auth") ?? {}
  if (!auth.isAdmin && !auth.userId && !auth.apiKeyId) return c.json({ error: "Unauthorized" }, 401)
  const bucket = c.req.query("bucket") ?? "hour"
  const axis = c.req.query("axis") ?? "model"
  if (bucket !== "hour" && bucket !== "day") return c.json({ error: "Invalid bucket" }, 400)
  if (axis !== "key" && axis !== "client" && axis !== "model" && axis !== "incomingModel") return c.json({ error: "Invalid axis" }, 400)
  const requestedKey = c.req.query("key_id")
  const query: UsageOverviewQuery = {
    start: c.req.query("start") ?? "", end: c.req.query("end") ?? "", bucket, axis,
    limit: c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit")),
    cursor: c.req.query("cursor"), client: c.req.query("client"), model: c.req.query("model"),
    incomingModel: c.req.query("incoming_model"),
  }
  try { validateUsageOverview(query) } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid query" }, 400)
  }
  const repo = getRepo()
  // API-key credentials are always narrower than a coexisting session/admin.
  if (auth.apiKeyId) return c.json(await repo.usage.queryOverview({ ...query, keyId: auth.apiKeyId }))
  const view = await deriveViewContext(c, auth)
  if ("denied" in view) return c.json({ error: "Not authorized to view this user's observability data" }, 403)
  if (view.isViewingShared && view.ownerId) {
    const owner = view.ownerId
    const secret = getServerSecret(c.env as unknown as Record<string, string | undefined>)
    const keys = await repo.apiKeys.listByOwner(owner)
    const keyIds = keys.filter(k => requestedKey === undefined || sharedKeyRef(owner, k.id, secret) === requestedKey).map(k => k.id)
    const result = await repo.usage.queryOverview({ ...query, keyIds })
    return c.json({ ...result, breakdown: { ...result.breakdown,
      rows: result.breakdown.rows.map(r => axis === "key" ? { ...r, value: sharedKeyRef(owner, r.value, secret) } : r),
    } })
  }
  if (auth.isAdmin) return c.json(await repo.usage.queryOverview({ ...query, keyId: requestedKey as ApiKeyId | undefined }))
  if (!auth.userId) return c.json({ error: "Unauthorized" }, 401)
  const keyIds = await repo.apiKeys.listAccessibleIds(auth.userId)
  return c.json(await repo.usage.queryOverview({ ...query, keyIds, keyId: requestedKey as ApiKeyId | undefined }))
})

tokenUsageRouter.get('/token-usage', async (c) => {
  const auth = c.get('auth') ?? {}
  const keyId = (c.req.query('key_id') || undefined) as ApiKeyId | undefined
  const start = c.req.query('start') ?? ''
  const end = c.req.query('end') ?? ''

  if (!start || !end) {
    return c.json(
      { error: 'start and end query parameters are required (e.g. 2026-03-09T00)' },
      400,
    )
  }

  const repo = getRepo()

  if (!auth.isAdmin && !auth.userId && !auth.apiKeyId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // Shared view: owned-only keys, redact keyIds
  if (!auth.apiKeyId && auth.isViewingShared && auth.ownerId) {
    const ownerId = auth.ownerId
    const ownedKeys = await repo.apiKeys.listByOwner(ownerId)
    const ids = ownedKeys.map(k => k.id)
    if (ids.length === 0) return c.json([])
    const secret = getServerSecret(c.env as unknown as Record<string, string | undefined>)
    const matchingIds = keyId
      ? ids.filter((id) => sharedKeyRef(ownerId, id, secret) === keyId)
      : ids
    if (matchingIds.length === 0) return c.json([])
    const records = await repo.usage.query({ keyIds: matchingIds as ApiKeyId[], start, end })
    const nameMap = new Map<string, string>(ownedKeys.map((k) => [k.id, k.name]))
    const enriched = enrichWithKeyName(aggregateUsageForDisplay(records), nameMap)
    return c.json(
      redactForSharedView({
        kind: 'tokenUsage',
        payload: enriched,
        ownerId,
        secret,
      }),
    )
  }

  let queryOpts: { keyId?: ApiKeyId; keyIds?: ApiKeyId[]; start: string; end: string }
  let keys: UsageKeyMetadata[]

  if (auth.apiKeyId) {
    // An API key is narrower than a coexisting session identity. Ignore a
    // caller-supplied key_id rather than letting it widen the scope.
    queryOpts = { keyId: auth.apiKeyId, start, end }
    keys = await repo.usage.queryKeyMetadata([auth.apiKeyId])
  } else if (auth.isAdmin) {
    queryOpts = { keyId, start, end }
    keys = await repo.usage.queryKeyMetadata()
  } else if (auth.userId) {
    const userKeys = await getUserKeys(auth.userId)
    if (userKeys.length === 0) return c.json([])
    if (keyId && !userKeys.some((k) => k.keyId === keyId)) return c.json([])
    queryOpts = keyId
      ? { keyId, start, end }
      : { keyIds: userKeys.map((k) => k.keyId), start, end }
    keys = userKeys
  } else {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const records = await repo.usage.query(queryOpts)
  const nameMap = new Map<string, string>(keys.map((k) => [k.keyId, k.keyName]))
  const display = aggregateUsageForDisplay(records)

  if (auth.isAdmin && !auth.apiKeyId) {
    const metadata = new Map<string, UsageKeyMetadata>(keys.map(k => [k.keyId, k]))
    return c.json(
      display.map((r) => {
        const key = metadata.get(r.keyId)
        const ownerId = key?.ownerId
        return {
          ...r,
          keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
          ownerId: ownerId ?? '',
          ownerName: ownerId ? (key?.ownerName ?? '') : '',
        }
      }),
    )
  }

  return c.json(enrichWithKeyName(display, nameMap))
})
