/**
 * Control-plane proxies router tests — covers both routers exported from
 * src/control-plane/proxies/routes.ts: the admin-only `proxiesRouter` (CRUD
 * only here — its /backoffs read/reset surface is currently untested) and the
 * label-only `proxyOptionsRouter`, which any authenticated user may read.
 *
 * Backed by a real in-memory SQLite repo rather than a hand-written fake: the
 * delete guard lives entirely in a SQL predicate (`NOT EXISTS ... json_each`),
 * so a TypeScript fake re-implementing it would prove nothing about the
 * behaviour under test. A pre-middleware injects `c.set('auth', ...)`,
 * matching the harness in control-plane-upstreams.test.ts.
 *
 * The /options case mounts the real `controlPlane` router rather than the two
 * sub-routers by hand, so that the mount order in src/control-plane/routes.ts
 * is what is under test — see that test's own comment.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo } from '../src/repo/index.ts'
import {
  proxiesRouter,
  type ProxyAuthCtx,
} from '../src/control-plane/proxies/routes.ts'
import { controlPlane } from '../src/control-plane/routes.ts'
import type { UserId } from '../src/repo/branded-ids.ts'
import { initSocketDial } from '@vibe-core/platform'

const TROJAN_URL = 'trojan://password@node1.example.com:443'

function buildApp(auth: ProxyAuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api/proxies', proxiesRouter)
  return app
}

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  initRepo(repo)
})

/** POST a proxy through the router and return the created record. */
async function createProxy(body: Record<string, unknown>) {
  const res = await buildApp({ isAdmin: true }).request('/api/proxies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { res, body: (await res.json()) as any }
}

test('GET /api/proxies as admin returns the node pool', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/proxies')
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body).toEqual({ proxies: [] })
})

test('GET /api/proxies non-admin → 403', async () => {
  const res = await buildApp({}).request('/api/proxies')
  expect(res.status).toBe(403)
})

test('POST /api/proxies creates a node and it shows up in the list', async () => {
  const { res, body } = await createProxy({
    name: 'node-1',
    url: TROJAN_URL,
    dialTimeoutSeconds: 12,
  })
  expect(res.status).toBe(201)
  expect(body.proxy.name).toBe('node-1')
  expect(body.proxy.url).toBe(TROJAN_URL)
  expect(body.proxy.dialTimeoutSeconds).toBe(12)
  expect(typeof body.proxy.id).toBe('string')
  expect(body.proxy.id.length).toBeGreaterThan(0)

  const listRes = await buildApp({ isAdmin: true }).request('/api/proxies')
  const listBody = await listRes.json() as any
  expect(listBody.proxies).toHaveLength(1)
  expect(listBody.proxies[0].id).toBe(body.proxy.id)
})

test('POST /api/proxies with an unsupported scheme → 400', async () => {
  const { res, body } = await createProxy({ name: 'bad', url: 'gopher://nope:1080' })
  expect(res.status).toBe(400)
  expect(body.error).toMatch(/gopher/)
})

test('POST /api/proxies non-admin → 403', async () => {
  const res = await buildApp({}).request('/api/proxies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'node-1', url: TROJAN_URL }),
  })
  expect(res.status).toBe(403)
})

test('PATCH /api/proxies/:id updates name and url', async () => {
  const created = await createProxy({ name: 'node-1', url: TROJAN_URL })
  const nextUrl = 'socks5://user:pw@node2.example.com:1080'

  const res = await buildApp({ isAdmin: true }).request(`/api/proxies/${created.body.proxy.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'renamed', url: nextUrl }),
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.proxy.name).toBe('renamed')
  expect(body.proxy.url).toBe(nextUrl)
})

test('PATCH /api/proxies/:id on an unknown id → 404', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/proxies/nope', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'renamed' }),
  })
  expect(res.status).toBe(404)
})

test('DELETE /api/proxies/:id removes an unreferenced node', async () => {
  const created = await createProxy({ name: 'node-1', url: TROJAN_URL })

  const res = await buildApp({ isAdmin: true }).request(`/api/proxies/${created.body.proxy.id}`, {
    method: 'DELETE',
  })
  expect(res.status).toBe(200)

  const listRes = await buildApp({ isAdmin: true }).request('/api/proxies')
  expect(((await listRes.json()) as any).proxies).toEqual([])
})

test('DELETE /api/proxies/:id on an unknown id → 404', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/proxies/nope', { method: 'DELETE' })
  expect(res.status).toBe(404)
})

test('DELETE /api/proxies/:id referenced by an upstream → 409 with upstreamIds', async () => {
  const created = await createProxy({ name: 'node-1', url: TROJAN_URL })
  const proxyId = created.body.proxy.id as string

  const now = new Date().toISOString()
  await repo.upstreams.save({
    id: 'ups-1',
    provider: 'copilot',
    name: 'ups-1',
    ownerId: 'u1',
    enabled: true,
    sortOrder: 0,
    config: {},
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
    proxyFallbackList: [{ id: proxyId }],
    createdAt: now,
    updatedAt: now,
  })

  const res = await buildApp({ isAdmin: true }).request(`/api/proxies/${proxyId}`, {
    method: 'DELETE',
  })
  expect(res.status).toBe(409)
  const body = await res.json() as any
  expect(body.upstreamIds).toEqual(['ups-1'])

  // The node must survive the refused delete.
  const listRes = await buildApp({ isAdmin: true }).request('/api/proxies')
  expect(((await listRes.json()) as any).proxies).toHaveLength(1)
})

test('GET /api/proxies/options as a non-admin returns id+name only', async () => {
  await createProxy({ name: 'node-1', url: TROJAN_URL })

  // Mount the real `controlPlane`, not the two sub-routers by hand: the
  // ordering of its two `route('/api/proxies…')` calls is load-bearing. If
  // `proxiesRouter` were mounted first, its `use('*')` admin gate would match
  // /api/proxies/options too and this non-admin request would get 403.
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', { userId: 'u1' as UserId })   // authenticated, not admin
    return next()
  })
  app.route('/', controlPlane)

  const res = await app.request('/api/proxies/options')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { proxies: Record<string, unknown>[] }
  expect(body.proxies).toHaveLength(1)
  // Assert the whole key set, not just the absence of `url`: a future field
  // carrying a credential would slip past `expect(p.url).toBeUndefined()`.
  expect(Object.keys(body.proxies[0]!).sort()).toEqual(['id', 'name'])
})

/**
 * POST /api/proxies/test —— 连通性测试。
 *
 * 用一个假的 SocketDial 顶掉真实网络。注意这个假 dial 能覆盖的边界：路由向
 * 锚点发请求时 `target.tls` 为 true，`runProxiedRequest` 会在代理握手之后再
 * 跑一次到锚点的 userspace TLS 握手，而那需要真实的 ServerHello + 证书链 ——
 * 一段字节脚本假冒不了。所以经由路由能钉住的是：鉴权、URI 解析、失败分级、
 * 以及"TLS 没谈成时绝不报成功"。
 *
 * "响应体是不是 IP" 这条判定 —— 也就是唯一能识破 trojan 密码错误时那个假
 * 网站的一步 —— 改为直接钉 `isExpectedEgressIp`，见文件末尾那组用例。
 */

/** 组装一段完整的 HTTP/1.1 响应字节流。 */
function httpResponse(body: string): Uint8Array {
  const bytes = new TextEncoder().encode(body)
  const head = `HTTP/1.1 200 OK\r\ncontent-length: ${bytes.byteLength}\r\nconnection: close\r\n\r\n`
  const headBytes = new TextEncoder().encode(head)
  const out = new Uint8Array(headBytes.byteLength + bytes.byteLength)
  out.set(headBytes, 0)
  out.set(bytes, headBytes.byteLength)
  return out
}

/**
 * 一个只会回放固定字节的 SocketDial。写入的字节被丢弃 —— 本组用例测的是
 * 路由如何处置这条连接，不是握手的字节格式（那由 packages/proxy 覆盖）。
 */
function scriptedSocketDial(responseBytes: Uint8Array) {
  return {
    connect: async () => ({
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(responseBytes)
          controller.close()
        },
      }),
      writable: new WritableStream<Uint8Array>({ write() {} }),
      close: async () => {},
    }),
  }
}

/** 一个 connect 就抛错的 SocketDial。 */
function failingSocketDial(message: string) {
  return {
    connect: async (): Promise<never> => {
      throw new Error(message)
    },
  }
}

async function postTest(body: Record<string, unknown>, auth: ProxyAuthCtx = { isAdmin: true }) {
  const res = await buildApp(auth).request('/api/proxies/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { res, body: (await res.json()) as any }
}

// HTTP CONNECT 代理是这组用例里最省事的载体：它的"握手"就是明文的
// `HTTP/1.1 200`，可以和随后的字节拼在同一段脚本里。
const HTTP_PROXY_URL = 'http://proxy.example.com:8080'
const CONNECT_OK = new TextEncoder().encode('HTTP/1.1 200 Connection Established\r\n\r\n')

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

test('POST /api/proxies/test 非管理员 → 403', async () => {
  const { res } = await postTest({ url: HTTP_PROXY_URL }, {})
  expect(res.status).toBe(403)
})

test('POST /api/proxies/test 无法解析的 URI → 400', async () => {
  const { res, body } = await postTest({ url: 'gopher://nope:1080' })
  expect(res.status).toBe(400)
  expect(body.error).toMatch(/gopher/)
})

test('POST /api/proxies/test 代理握手成功但锚点回明文 → ok:false，不报成功', async () => {
  // 代理把 CONNECT 应答得漂漂亮亮，随后的字节却是明文 HTTP 而不是 TLS ——
  // 一个只会伪装握手的中间人正是这个形状。到锚点的 TLS 谈不成，就绝不能
  // 有 egressIp 回给前端。
  initSocketDial(scriptedSocketDial(concatBytes(CONNECT_OK, httpResponse('203.0.113.7\n'))))
  const { res, body } = await postTest({ url: HTTP_PROXY_URL })
  expect(res.status).toBe(200)
  expect(body.ok).toBe(false)
  expect(body.egressIp).toBeUndefined()
  expect(body.error).toMatch(/^\[inner-tls\]/)
})

test('POST /api/proxies/test 拨号失败 → ok:false 且错误带 stage 前缀', async () => {
  initSocketDial(failingSocketDial('ECONNREFUSED'))
  const { res, body } = await postTest({ url: HTTP_PROXY_URL })
  expect(res.status).toBe(200)
  expect(body.ok).toBe(false)
  expect(body.error).toMatch(/^\[(config|tcp-connect|outer-tls|proxy-handshake|inner-tls)\]/)
})

test('POST /api/proxies/test 报错不得回显 proxy URI（密码泄漏）', async () => {
  initSocketDial(failingSocketDial('ECONNREFUSED'))
  const { body } = await postTest({ url: 'trojan://sup3rs3cret@node1.example.com:443' })
  expect(JSON.stringify(body)).not.toMatch(/sup3rs3cret/)
})
