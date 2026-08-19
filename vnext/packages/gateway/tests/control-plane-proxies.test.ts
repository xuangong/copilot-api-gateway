/**
 * Control-plane proxies router tests.
 *
 * Backed by a real in-memory SQLite repo rather than a hand-written fake: the
 * delete guard lives entirely in a SQL predicate (`NOT EXISTS ... json_each`),
 * so a TypeScript fake re-implementing it would prove nothing about the
 * behaviour under test. A pre-middleware injects `c.set('auth', ...)`,
 * matching the harness in control-plane-upstreams.test.ts.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo } from '../src/repo/index.ts'
import { proxiesRouter, type ProxyAuthCtx } from '../src/control-plane/proxies/routes.ts'

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
