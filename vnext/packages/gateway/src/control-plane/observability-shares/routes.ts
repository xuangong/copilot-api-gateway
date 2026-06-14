/**
 * Observability-shares control-plane router — Week 5a-impl.
 *
 * Ported 1:1 from old src/routes/observability-shares.ts (Elysia → Hono).
 * All four endpoints require session auth (not API-key); JSON shapes, status
 * codes, and mount paths match old project verbatim.
 *
 * Auth model: handlers read `c.get('auth')` and require
 * `authKind === 'session' && userId`. The session auth middleware is not yet
 * ported in vnext; tests inject auth via a pre-middleware.
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../shared/repo/index.ts'

export interface AuthCtx {
  userId?: string
  authKind?: 'public' | 'session' | 'apiKey'
}

type Vars = { auth: AuthCtx }

export const observabilitySharesRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

observabilitySharesRouter.get('/_health', (c) =>
  c.json({ scope: 'control-plane:observability-shares', status: 'scaffold' }),
)

function requireSession(c: { get: (k: 'auth') => AuthCtx | undefined }): { userId: string } | null {
  const auth = c.get('auth') ?? {}
  if (auth.authKind !== 'session' || !auth.userId) return null
  return { userId: auth.userId }
}

observabilitySharesRouter.post('/', async (c) => {
  const sess = requireSession(c)
  if (!sess) return c.json({ error: 'Forbidden' }, 403)
  const body = await c.req.json().catch(() => ({})) as { viewerEmail?: string }
  const viewerEmail = body.viewerEmail
  if (!viewerEmail) return c.json({ error: 'viewerEmail is required' }, 400)
  const repo = getRepo()
  const viewer = await repo.users.findByEmail(viewerEmail.toLowerCase())
  if (!viewer) return c.json({ error: 'viewer email not found' }, 404)
  if (viewer.id === sess.userId) return c.json({ error: 'cannot share with yourself' }, 400)
  await repo.observabilityShares.share(sess.userId, viewer.id, sess.userId)
  return c.json({
    ownerId: sess.userId,
    viewerId: viewer.id,
    viewerEmail: viewer.email,
    viewerName: viewer.name,
  })
})

observabilitySharesRouter.delete('/:viewerId', async (c) => {
  const sess = requireSession(c)
  if (!sess) return c.json({ error: 'Forbidden' }, 403)
  const viewerId = c.req.param('viewerId')
  await getRepo().observabilityShares.unshare(sess.userId, viewerId)
  return c.json({ ok: true })
})

observabilitySharesRouter.get('/granted-by-me', async (c) => {
  const sess = requireSession(c)
  if (!sess) return c.json({ error: 'Forbidden' }, 403)
  const repo = getRepo()
  const grants = await repo.observabilityShares.listByOwner(sess.userId)
  const viewers = await Promise.all(grants.map((g) => repo.users.getById(g.viewerId)))
  return c.json(
    grants.map((g, i) => ({
      viewerId: g.viewerId,
      viewerEmail: viewers[i]?.email,
      viewerName: viewers[i]?.name,
      grantedAt: g.grantedAt,
    })),
  )
})

observabilitySharesRouter.get('/granted-to-me', async (c) => {
  const sess = requireSession(c)
  if (!sess) return c.json({ error: 'Forbidden' }, 403)
  const repo = getRepo()
  const grants = await repo.observabilityShares.listByViewer(sess.userId)
  const owners = await Promise.all(grants.map((g) => repo.users.getById(g.ownerId)))
  return c.json(
    grants.map((g, i) => ({
      ownerId: g.ownerId,
      ownerEmail: owners[i]?.email,
      ownerName: owners[i]?.name,
      grantedAt: g.grantedAt,
    })),
  )
})
