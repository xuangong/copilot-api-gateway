/**
 * Control-plane proxies router tests.
 *
 * Uses an in-memory Repo + a pre-middleware to inject `c.set('auth', ...)`,
 * matching the harness in control-plane-upstreams.test.ts.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/repo/index.ts'
import type { Repo } from '../src/repo/types.ts'
import { proxiesRouter, type ProxyAuthCtx } from '../src/control-plane/proxies/routes.ts'

function inMemoryRepo() {
  const proxies = new Map<string, any>()
  const backoffs: any[] = []

  const repo = {
    proxies: {
      list: async () => [...proxies.values()],
      getById: async (id: string) => proxies.get(id) ?? null,
      deleteAll: async () => { proxies.clear() },
      findUpstreamsReferencing: async () => [],
    },
    proxyBackoffs: {
      listAll: async () => [...backoffs],
      listForProxy: async () => [],
      listForUpstream: async () => [],
      deleteAll: async () => { backoffs.length = 0 },
    },
  } as unknown as Repo

  return { repo, proxies, backoffs }
}

function buildApp(auth: ProxyAuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api/proxies', proxiesRouter)
  return app
}

let store: ReturnType<typeof inMemoryRepo>

beforeEach(() => {
  store = inMemoryRepo()
  initRepo(store.repo)
})

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
