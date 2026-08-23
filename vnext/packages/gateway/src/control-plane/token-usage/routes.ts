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
import { getRepo } from '../../repo/index.ts'
import type { ApiKey } from '../../repo/types.ts'
import { aggregateUsageForDisplay, type DisplayUsageRecord } from './aggregate.ts'
import {
  redactForSharedView,
  getServerSecret,
} from '../lib/redact-shared-view.ts'
import { getOwnedKeyIdsForScope } from '../lib/view-context.ts'
import type { ApiKeyId, UserId } from '../../repo/branded-ids.ts'

export interface TokenUsageAuthCtx {
  isAdmin?: boolean
  userId?: UserId
  isViewingShared?: boolean
  ownerId?: UserId
}

type Vars = { auth: TokenUsageAuthCtx }

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
  // people the viewer is not otherwise shown. Same for a caller with no
  // identity to scope by.
  if (auth.isViewingShared || (!auth.isAdmin && !auth.userId)) return c.json([])

  const keys = auth.isAdmin ? await repo.apiKeys.list() : await getUserKeys(auth.userId!)
  const assignmentsPerKey = await Promise.all(keys.map((k) => repo.keyAssignments.listByKey(k.id)))

  const wantedUserIds = new Set<string>()
  for (const k of keys) if (k.ownerId) wantedUserIds.add(k.ownerId)
  for (const list of assignmentsPerKey) for (const a of list) wantedUserIds.add(a.userId)
  const named = await Promise.all([...wantedUserIds].map((id) => repo.users.getById(id as UserId)))
  const nameOf = new Map<string, string>()
  for (const u of named) if (u) nameOf.set(u.id, u.name)

  return c.json(
    keys.map((k, i) => {
      // Being given access to a key does not entitle you to the roster of who
      // else has it; the Keys tab draws the same line (KeyRow.tsx only lists
      // assignees to the owner).
      const maySeeAssignees = auth.isAdmin || k.ownerId === auth.userId
      return {
        keyId: k.id,
        ownerId: k.ownerId ?? null,
        ownerName: k.ownerId ? (nameOf.get(k.ownerId) ?? null) : null,
        sharedWith: maySeeAssignees
          ? assignmentsPerKey[i]!.map((a) => ({ id: a.userId, name: nameOf.get(a.userId) ?? a.userId.slice(0, 8) }))
          : [],
      }
    }),
  )
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

  // Shared view: owned-only keys, redact keyIds
  if (auth.isViewingShared && auth.ownerId) {
    const ids = await getOwnedKeyIdsForScope(auth.ownerId)
    if (ids.length === 0) return c.json([])
    const ownedKeys = await repo.apiKeys.listByOwner(auth.ownerId)
    const records = await repo.usage.query({ keyIds: ids as ApiKeyId[], start, end })
    const nameMap = new Map<string, string>(ownedKeys.map((k) => [k.id, k.name]))
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

  const records = await repo.usage.query(queryOpts)
  const nameMap = new Map<string, string>(keys.map((k) => [k.id, k.name]))
  const display = aggregateUsageForDisplay(records)

  if (auth.isAdmin) {
    const ownerIdMap = new Map<string, UserId | undefined>(keys.map((k) => [k.id, k.ownerId]))
    const userIds = new Set(keys.map((k) => k.ownerId).filter(Boolean) as UserId[])
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
