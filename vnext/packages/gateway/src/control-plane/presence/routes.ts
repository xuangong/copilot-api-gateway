/**
 * presence control-plane router — Week 5b port of
 * src/routes/dashboard.ts (POST /heartbeat, GET /relays).
 *
 * - POST /heartbeat: API-key-authenticated; relay clients call to report presence.
 * - GET /relays: 4-branch scoping (admin / shared-view / user / fallback empty).
 *   Shared view uses redactForSharedView({ kind: 'relays', ... }).
 *   Enriches each row with isOnline (lastSeen<3min) + isActive (usage in last 2h).
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../../app.ts'
import { zValidator } from '../../shared/middleware/zod-validator.ts'
import { getRepo } from '../../shared/repo/index.ts'
import type { ApiKey } from '../../shared/repo/types.ts'
import type { ApiKeyId, UserId } from '../../shared/repo/branded-ids.ts'
import {
  redactForSharedView,
  getServerSecret,
} from '../../shared/lib/redact-shared-view.ts'
import { getOwnedKeyIdsForScope } from '../../shared/lib/view-context.ts'

export interface PresenceAuthCtx {
  isAdmin?: boolean
  userId?: UserId
  apiKeyId?: ApiKeyId
  isViewingShared?: boolean
  ownerId?: UserId
}

type Vars = { auth: PresenceAuthCtx }

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
  const onlineThresholdMinutes = 3

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
  const activeThresholdHours = 2
  const activeHour = new Date(now - activeThresholdHours * 3600 * 1000)
    .toISOString()
    .slice(0, 13)
  const endHour = new Date(now + 3600 * 1000).toISOString().slice(0, 13)

  const keyIds = [...new Set(clients.map((c) => c.keyId).filter(Boolean) as ApiKeyId[])]
  const activeKeyIds = new Set<string>()
  if (keyIds.length > 0) {
    try {
      const usageRows = await repo.usage.query({ keyIds, start: activeHour, end: endHour })
      for (const r of usageRows) activeKeyIds.add(r.keyId)
    } catch {
      // usage query failure should not break relays endpoint
    }
  }

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
    isOnline: now - new Date(cli.lastSeenAt).getTime() < onlineThresholdMinutes * 60 * 1000,
    isActive: cli.keyId ? activeKeyIds.has(cli.keyId) : false,
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
