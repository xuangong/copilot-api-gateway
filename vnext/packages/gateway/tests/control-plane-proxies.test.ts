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
