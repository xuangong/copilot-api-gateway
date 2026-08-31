/**
 * presence control-plane router — Week 5b port of
 * src/routes/dashboard.ts (POST /heartbeat, GET /relays).
 *
 * - POST /heartbeat: API-key-authenticated; relay clients call to report presence.
 * - GET /relays: 4-branch scoping (admin / shared-view / user / fallback empty).
 *   Shared view uses redactForSharedView({ kind: 'relays', ... }).
 *   Enriches each row with isOnline (lastSeen<3min), and prunes long-dead rows.
 *
 * There used to be a third state, isActive, defined as "this key had usage in
 * the last 2 hours". It was rendered per-device, but the predicate is per-key:
 * with N devices sharing one key, any one of them making a request lit up all
 * N — including ones last seen months earlier. Device-level traffic is not
 * computable here at all, because `usage` is bucketed by key_id only and
 * carries no client_id. Rather than keep a plausible-looking lie, the state is
 * gone; see the header comment on PRESENCE_TTL_MINUTES for the other half of
 * why the list looked inflated.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../../app.ts'
import { zValidator } from '../middleware/zod-validator.ts'
import { getRepo } from '../../repo/index.ts'
import type { ApiKey } from '../../repo/types.ts'
import type { ApiKeyId, UserId } from '../../repo/branded-ids.ts'
import {
  redactForSharedView,
  getServerSecret,
} from '../lib/redact-shared-view.ts'
import { getOwnedKeyIdsForScope } from '../lib/view-context.ts'

export interface PresenceAuthCtx {
  isAdmin?: boolean
  userId?: UserId
  apiKeyId?: ApiKeyId
  isViewingShared?: boolean
  ownerId?: UserId
}

type Vars = { auth: PresenceAuthCtx }

/** A heartbeat within this window means the device is up. */
const ONLINE_THRESHOLD_MINUTES = 3

/**
 * Rows older than this are deleted on the next /relays read.
 *
 * Device identity is the relay's `clientId`, a UUID it keeps in its own local
 * config. Reinstalling the relay, resetting its config, or moving it into a
 * fresh container mints a new UUID, so the same physical machine upserts a new
 * row and the old one is orphaned forever. Until the relay reports a stable
 * OS-level machine id we cannot merge those rows — the payload carries nothing
 * that identifies hardware — so the next best thing is to let the orphans age
 * out.
 *
 * Deleting is cheap to get wrong in our favour: heartbeat is an upsert, so a
 * machine that comes back simply recreates its row on the next beat. Nothing
 * here is a source of truth.
 */
const PRESENCE_TTL_MINUTES = 30 * 24 * 60

async function getUserKeyIds(userId: UserId): Promise<ApiKeyId[]> {
  const repo = getRepo()
  const [ownKeys, assignments] = await Promise.all([
    repo.apiKeys.listByOwner(userId),
    repo.keyAssignments.listByUser(userId),
  ])
  const ids = new Set<ApiKeyId>(ownKeys.map((k: ApiKey) => k.id))
  for (const a of assignments) ids.add(a.keyId)
  return [...ids]
}

function getEnvSecret(c: { env: unknown }): string {
  return getServerSecret(c.env as Record<string, string | undefined>)
}

export const presenceRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

const heartbeatBody = z.object({
  clientId: z.string().min(1, 'clientId and hostname are required'),
  clientName: z.string().optional(),
  hostname: z.string().min(1, 'clientId and hostname are required'),
  gatewayUrl: z.string().optional(),
})

presenceRouter.post('/heartbeat', zValidator('json', heartbeatBody), async (c) => {
  const auth = c.get('auth') ?? {}
  if (!auth.apiKeyId) {
    return c.json({ error: 'API key required for heartbeat' }, 401)
  }
  const { clientId, clientName, hostname, gatewayUrl } = c.req.valid('json')
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('cf-connecting-ip') ??
    null
  const ipSuffix = ip ? ` (${ip})` : ''
  const displayName = clientName
    ? `${clientName}@${hostname}${ipSuffix}`
    : `${hostname}${ipSuffix}`

  const repo = getRepo()
  const apiKey = await repo.apiKeys.getById(auth.apiKeyId)
  await repo.presence.upsert({
    clientId,
    clientName: displayName,
    keyId: auth.apiKeyId,
    keyName: apiKey?.name ?? null,
    ownerId: auth.userId ?? null,
    gatewayUrl: gatewayUrl ?? null,
    lastSeenAt: new Date().toISOString(),
  })
  return c.json({ ok: true })
})

presenceRouter.get('/relays', async (c) => {
  const auth = c.get('auth') ?? {}
  const repo = getRepo()

  // Prune before listing so the response already reflects the cleanup. Failure
  // is not worth failing the read over — the stale rows just survive one more
  // round.
  try {
    await repo.presence.pruneStale(PRESENCE_TTL_MINUTES)
  } catch {
    // best effort
  }

  let clients
  if (auth.isAdmin) {
    clients = await repo.presence.list()
  } else if (auth.isViewingShared && auth.ownerId) {
    const ids = await getOwnedKeyIdsForScope(auth.ownerId)
    if (ids.length === 0) return c.json([])
    clients = await repo.presence.listByKeyIds(ids as ApiKeyId[])
  } else if (auth.userId) {
    const userKeyIds = await getUserKeyIds(auth.userId)
    clients = await repo.presence.listByKeyIds(userKeyIds)
  } else {
    return c.json([])
  }

  const now = Date.now()

  const ownerNameMap = new Map<string, string>()
  if (auth.isAdmin) {
    const ownerIds = [...new Set(clients.map((c) => c.ownerId).filter(Boolean) as string[])]
    if (ownerIds.length > 0) {
      const users = await Promise.all(ownerIds.map((id) => repo.users.getById(id as UserId)))
      for (const u of users) {
        if (u) ownerNameMap.set(u.id, u.name)
      }
    }
  }

  const enriched = clients.map((cli) => ({
    ...cli,
    isOnline: now - new Date(cli.lastSeenAt).getTime() < ONLINE_THRESHOLD_MINUTES * 60 * 1000,
    ownerName: cli.ownerId ? (ownerNameMap.get(cli.ownerId) ?? null) : null,
  }))

  if (auth.isViewingShared && auth.ownerId) {
    return c.json(
      redactForSharedView({
        kind: 'relays',
        payload: enriched as unknown as Array<Record<string, unknown> & { clientId: string }>,
        ownerId: auth.ownerId,
        secret: getEnvSecret(c),
      }),
    )
  }
  return c.json(enriched)
})
