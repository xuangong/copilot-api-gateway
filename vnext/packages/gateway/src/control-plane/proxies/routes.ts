/**
 * proxies control-plane router — admin-only CRUD over the global proxy node
 * pool plus a read/reset surface over the per-(proxy, upstream) backoff table.
 *
 * Admin-only in full: `proxies.url` embeds the credential (e.g.
 * `trojan://password@host:port`), and the Upstreams tab is `userOk: true`.
 * Gating the whole router keeps the secret out of non-admin reach without
 * needing a redaction layer.
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../repo/index.ts'
import type { ApiKeyId, UserId } from '../../repo/branded-ids.ts'

export interface ProxyAuthCtx {
  isAdmin?: boolean
  userId?: UserId
  apiKeyId?: ApiKeyId
}

type Vars = { auth: ProxyAuthCtx }

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
