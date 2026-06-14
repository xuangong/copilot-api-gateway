/**
 * token-usage control-plane router — Week 5b port of
 * src/routes/dashboard.ts (GET /token-usage).
 *
 * 4-branch scoping:
 *   - admin           → all keys + enrich with ownerId/ownerName
 *   - shared view     → owned-only keys for ownerId + HMAC-redact keyIds
 *   - user (session)  → owned + assigned keys
 *   - fallback (e.g. apiKey caller w/o userId) → key_id query honored, list() keys
 *
 * Cost is summed from each row's per-dimension `cost` snapshot (frozen at
 * write time) via `aggregateUsageForDisplay`; the global pricing table is
 * never consulted at read time, so historical cost is stable when pricing
 * later changes. See aggregate.ts for the math.
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../shared/repo/index.ts'
import type { ApiKey } from '../../shared/repo/types.ts'
import { aggregateUsageForDisplay, type DisplayUsageRecord } from './aggregate.ts'
import {
  redactForSharedView,
  getServerSecret,
} from '../../shared/lib/redact-shared-view.ts'
import { getOwnedKeyIdsForScope } from '../../shared/lib/view-context.ts'

export interface TokenUsageAuthCtx {
  isAdmin?: boolean
  userId?: string
  isViewingShared?: boolean
  ownerId?: string
}

type Vars = { auth: TokenUsageAuthCtx }

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
    for (const k of assignedKeys) {
      if (k) keyMap.set(k.id, k)
    }
  }
  return [...keyMap.values()]
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

tokenUsageRouter.get('/token-usage', async (c) => {
  const auth = c.get('auth') ?? {}
  const keyId = c.req.query('key_id') || undefined
  const start = c.req.query('start') ?? ''
  const end = c.req.query('end') ?? ''

  if (!start || !end) {
    return c.json(
      { error: 'start and end query parameters are required (e.g. 2026-03-09T00)' },
      400,
    )
  }

  const repo = getRepo()

  // Shared view: owned-only keys, redact keyIds
  if (auth.isViewingShared && auth.ownerId) {
    const ids = await getOwnedKeyIdsForScope(auth.ownerId)
    if (ids.length === 0) return c.json([])
    const ownedKeys = await repo.apiKeys.listByOwner(auth.ownerId)
    const records = await repo.usage.query({ keyIds: ids, start, end })
    const nameMap = new Map(ownedKeys.map((k) => [k.id, k.name]))
    const enriched = enrichWithKeyName(aggregateUsageForDisplay(records), nameMap)
    return c.json(
      redactForSharedView({
        kind: 'tokenUsage',
        payload: enriched,
        ownerId: auth.ownerId,
        secret: getServerSecret(c.env as unknown as Record<string, string | undefined>),
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

  const records = await repo.usage.query(queryOpts)
  const nameMap = new Map(keys.map((k) => [k.id, k.name]))
  const display = aggregateUsageForDisplay(records)

  if (auth.isAdmin) {
    const ownerIdMap = new Map(keys.map((k) => [k.id, k.ownerId]))
    const userIds = new Set(keys.map((k) => k.ownerId).filter(Boolean) as string[])
    const users = await Promise.all([...userIds].map((id) => repo.users.getById(id)))
    const userNameMap = new Map<string, string>()
    for (const u of users) {
      if (u) userNameMap.set(u.id, u.name)
    }
    return c.json(
      display.map((r) => {
        const ownerId = ownerIdMap.get(r.keyId)
        return {
          ...r,
          keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
          ownerId: ownerId ?? '',
          ownerName: ownerId ? (userNameMap.get(ownerId) ?? '') : '',
        }
      }),
    )
  }

  return c.json(enrichWithKeyName(display, nameMap))
})
