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
import { ProxyDialError, runProxiedRequest } from '@vibe-core/proxy'
import { getSocketDial } from '@vibe-core/platform'
import { ANCHORS, isIpV4, isIpV6, type AnchorName } from './egress-probe.ts'
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

/**
 * 锚点回显的正文是否是一个可接受的出口 IP。v6 专用锚点必须回 v6 —— 回了
 * v4 说明流量根本没到那个锚点。
 *
 * 单独导出是为了让这条判定能被直接钉住：路由自身走到这一步要先完成一次
 * 到锚点的真实 userspace TLS 握手，用字节脚本假冒不了。
 */
export const isExpectedEgressIp = (anchor: AnchorName, text: string): boolean =>
  anchor === 'ident.me-v6' ? isIpV6(text) : isIpV4(text) || isIpV6(text)

const testBody = z.object({
  url: z.string().min(1),
  dialTimeoutSeconds: z.number().int().positive().nullish(),
  anchor: z.enum(['ipify', 'aws', 'ident.me-v6']).optional(),
})

/**
 * 连通性测试：走真实隧道向一个外部锚点发 GET，把响应体当作出口 IP 回显。
 *
 * 判定标准刻意是"响应体是一个合法 IP"而不是"连上了" —— trojan 服务端在
 * 密码错误时按设计返回一个假网站，TCP / TLS / 握手三段全部成功，只有校验
 * 响应体形状能把认证失败和真正连通区分开。
 *
 * 接受完整 URI 而不是 proxy id，这样 dashboard 上尚未保存的草稿也能测。
 */
proxiesRouter.post('/test', async (c) => {
  const parsed = testBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)

  let config
  try {
    config = parseProxyUri(parsed.data.url.trim())
  } catch (err) {
    // ProxyUriError 的 message 会回显冒犯的 URI，而 trojan URI 里带密码。
    // 只有 scheme 是安全可回显的，其余一律折叠成一句通用文案。
    const scheme = parsed.data.url.trim().split(':')[0] ?? ''
    void err
    return c.json({ error: `unsupported or malformed proxy URI (scheme: ${scheme})` }, 400)
  }

  const anchorName: AnchorName = parsed.data.anchor ?? 'ipify'
  const anchor = ANCHORS[anchorName]
  const dialTimeoutMs = parsed.data.dialTimeoutSeconds
    ? parsed.data.dialTimeoutSeconds * 1000
    : undefined

  try {
    const res = await runProxiedRequest(
      config,
      { host: anchor.host, port: anchor.port, tls: true },
      {
        method: 'GET',
        path: anchor.path,
        headers: { host: anchor.host, 'user-agent': 'vibe-proxy-test/1', connection: 'close' },
      },
      { socketDial: getSocketDial(), ...(dialTimeoutMs === undefined ? {} : { dialTimeoutMs }) },
    )
    // 截断到 256 字符再判定：合法锚点只回一行 IP，而假网站的正文可以任意
    // 长，截断把它挡在后续判定之外。（正文此时已整段读入 —— 这里不省内存。）
    const text = (await res.text()).slice(0, 256).trim()
    if (!isExpectedEgressIp(anchorName, text)) {
      // 不回显 text 本身 —— 它可能是攻击者控制的任意内容。
      return c.json({ ok: false, error: 'anchor did not return an IP address' })
    }
    return c.json({ ok: true, egressIp: text })
  } catch (err) {
    if (err instanceof ProxyDialError) {
      return c.json({ ok: false, error: `[${err.stage}] ${err.message}` })
    }
    throw err
  }
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
