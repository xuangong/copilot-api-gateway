/**
 * proxies control-plane routers.
 *
 * `proxiesRouter` is admin-only in full: CRUD over the global proxy node pool
 * plus a read/reset surface over the per-(proxy, upstream) backoff table. It
 * exposes `proxies.url`, which embeds the credential (e.g.
 * `trojan://password@host:port`), and the Upstreams tab is `userOk: true`.
 * Gating that whole router keeps the secret out of non-admin reach without
 * needing a redaction layer.
 *
 * `proxyOptionsRouter` is the one non-admin surface: a label-only (id + name)
 * view of the same pool, kept in a separate router so it sits outside that
 * gate. See its own comment below.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { parseProxyUri } from '@vibe-core/proxy/url'
import type { Env } from '../../app.ts'
import { getRepo } from '../../repo/index.ts'
import type { ApiKeyId, UserId } from '../../repo/branded-ids.ts'

export interface ProxyAuthCtx {
  isAdmin?: boolean
  userId?: UserId
  apiKeyId?: ApiKeyId
}

type Vars = { auth: ProxyAuthCtx }

/**
 * Label-only view of the node pool, mounted separately from `proxiesRouter`
 * so it sits outside that router's admin gate. A non-admin adding a Copilot
 * account needs to pick an egress node by name; they must never see the URL,
 * which embeds the proxy password. Deliberately not a query parameter on the
 * admin list — one handler, one projection, no flag to get wrong.
 */
export const proxyOptionsRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

proxyOptionsRouter.get('/', async (c) => {
  const auth = c.get('auth')
  if (!auth?.userId && !auth?.apiKeyId && !auth?.isAdmin) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const proxies = await getRepo().proxies.list()
  return c.json({ proxies: proxies.map((p) => ({ id: p.id, name: p.name })) })
})

export const proxiesRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

proxiesRouter.use('*', async (c, next) => {
  if (!c.get('auth')?.isAdmin) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
})

proxiesRouter.get('/', async (c) => {
  const proxies = await getRepo().proxies.list()
  return c.json({ proxies })
})

proxiesRouter.get('/backoffs', async (c) => {
  const backoffs = await getRepo().proxyBackoffs.listAll()
  return c.json({ backoffs })
})

const createBody = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  dialTimeoutSeconds: z.number().int().positive().nullable().optional(),
})

const patchBody = z.object({
  name: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  dialTimeoutSeconds: z.number().int().positive().nullable().optional(),
})

/** Validate a proxy URI, returning the parse error message on failure. */
function urlError(url: string): string | null {
  try {
    parseProxyUri(url)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

proxiesRouter.post('/', async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)

  const err = urlError(parsed.data.url)
  if (err) return c.json({ error: err }, 400)

  const proxy = await getRepo().proxies.insert({
    id: crypto.randomUUID(),
    name: parsed.data.name.trim(),
    url: parsed.data.url.trim(),
    dialTimeoutSeconds: parsed.data.dialTimeoutSeconds ?? null,
  })
  return c.json({ proxy }, 201)
})

proxiesRouter.patch('/:id', async (c) => {
  const parsed = patchBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)

  if (parsed.data.url !== undefined) {
    const err = urlError(parsed.data.url)
    if (err) return c.json({ error: err }, 400)
  }

  const result = await getRepo().proxies.patch(c.req.param('id'), parsed.data)
  if (!result) return c.json({ error: 'Not found' }, 404)
  return c.json({ proxy: result.record })
})

proxiesRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const repo = getRepo()
  // `ProxyRepo.delete` returns false for BOTH "missing" and "still
  // referenced" — the reference predicate is folded into the DELETE to close
  // a TOCTOU window. Probe first so the caller gets 404 vs 409, not one
  // ambiguous status.
  const existing = await repo.proxies.getById(id)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const deleted = await repo.proxies.delete(id)
  if (!deleted) {
    const upstreamIds = await repo.proxies.findUpstreamsReferencing(id)
    return c.json({ error: 'Proxy is still referenced', upstreamIds }, 409)
  }
  return c.json({ ok: true })
})

proxiesRouter.delete('/:id/backoffs', async (c) => {
  await getRepo().proxyBackoffs.resetForProxy(c.req.param('id'))
  return c.json({ ok: true })
})
