/**
 * Control-plane observability-shares router tests — Week 5a-impl.
 *
 * Covers the 4 endpoints ported from old src/routes/observability-shares.ts.
 * All endpoints require session auth; API-key / unauthenticated → 403.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { setRepoForTest } from '../src/shared/repo/index.ts'
import type { ObservabilityShare, Repo, User } from '../src/shared/repo/types.ts'
import {
  observabilitySharesRouter,
  type AuthCtx,
} from '../src/control-plane/observability-shares/routes.ts'

function inMemoryRepo() {
  const users = new Map<string, User>()
  const shares: ObservabilityShare[] = []

  const repo = {
    users: {
      create: async (u: User) => { users.set(u.id, u) },
      getById: async (id: string) => users.get(id) ?? null,
      findByKey: async () => null,
      findByEmail: async (email: string) =>
        [...users.values()].find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null,
      list: async () => [...users.values()],
      update: async () => { },
      delete: async (id: string) => { users.delete(id) },
    },
    observabilityShares: {
      share: async (ownerId: string, viewerId: string, grantedBy: string) => {
        shares.push({ ownerId, viewerId, grantedBy, grantedAt: new Date().toISOString() })
      },
      unshare: async (ownerId: string, viewerId: string) => {
        for (let i = shares.length - 1; i >= 0; i--) {
          if (shares[i]!.ownerId === ownerId && shares[i]!.viewerId === viewerId) shares.splice(i, 1)
        }
      },
      listByOwner: async (ownerId: string) => shares.filter((s) => s.ownerId === ownerId),
      listByViewer: async (viewerId: string) => shares.filter((s) => s.viewerId === viewerId),
      isGranted: async (ownerId: string, viewerId: string) =>
        shares.some((s) => s.ownerId === ownerId && s.viewerId === viewerId),
      deleteByOwner: async () => { },
      deleteByViewer: async () => { },
    },
  } as unknown as Repo

  return { repo, users, shares }
}

function buildApp(auth: AuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api/observability-shares', observabilitySharesRouter)
  return app
}

let store: ReturnType<typeof inMemoryRepo>

beforeEach(() => {
  store = inMemoryRepo()
  setRepoForTest(store.repo)
})

test('POST unauthenticated → 403', async () => {
  const res = await buildApp({}).request('/api/observability-shares', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(403)
})

test('POST with apiKey auth → 403', async () => {
  const res = await buildApp({ authKind: 'apiKey', userId: 'u1' }).request('/api/observability-shares', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(403)
})

test('POST missing viewerEmail → 400', async () => {
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/observability-shares', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST viewer not found → 404', async () => {
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/observability-shares', {
    method: 'POST',
    body: JSON.stringify({ viewerEmail: 'missing@x.com' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(404)
})

test('POST self-share → 400', async () => {
  await store.repo.users.create({ id: 'u1', name: 'Alice', email: 'alice@x.com', createdAt: 'x', disabled: false })
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/observability-shares', {
    method: 'POST',
    body: JSON.stringify({ viewerEmail: 'alice@x.com' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST success returns viewer descriptor', async () => {
  await store.repo.users.create({ id: 'u1', name: 'Alice', email: 'alice@x.com', createdAt: 'x', disabled: false })
  await store.repo.users.create({ id: 'u2', name: 'Bob', email: 'bob@x.com', createdAt: 'x', disabled: false })
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/observability-shares', {
    method: 'POST',
    body: JSON.stringify({ viewerEmail: 'BOB@x.com' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body).toEqual({ ownerId: 'u1', viewerId: 'u2', viewerEmail: 'bob@x.com', viewerName: 'Bob' })
  expect(store.shares).toHaveLength(1)
})

test('DELETE removes the share', async () => {
  await store.repo.users.create({ id: 'u1', name: 'A', email: 'a@x.com', createdAt: 'x', disabled: false })
  await store.repo.users.create({ id: 'u2', name: 'B', email: 'b@x.com', createdAt: 'x', disabled: false })
  await store.repo.observabilityShares.share('u1', 'u2', 'u1')
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/observability-shares/u2', {
    method: 'DELETE',
  })
  expect(res.status).toBe(200)
  expect(store.shares).toHaveLength(0)
})

test('DELETE unauthenticated → 403', async () => {
  const res = await buildApp({}).request('/api/observability-shares/u2', { method: 'DELETE' })
  expect(res.status).toBe(403)
})

test('GET granted-by-me joins viewer email/name', async () => {
  await store.repo.users.create({ id: 'u1', name: 'A', email: 'a@x.com', createdAt: 'x', disabled: false })
  await store.repo.users.create({ id: 'u2', name: 'Bob', email: 'bob@x.com', createdAt: 'x', disabled: false })
  await store.repo.observabilityShares.share('u1', 'u2', 'u1')
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/observability-shares/granted-by-me')
  expect(res.status).toBe(200)
  const body = await res.json() as any[]
  expect(body).toHaveLength(1)
  expect(body[0]).toMatchObject({ viewerId: 'u2', viewerEmail: 'bob@x.com', viewerName: 'Bob' })
  expect(typeof body[0].grantedAt).toBe('string')
})

test('GET granted-to-me joins owner email/name', async () => {
  await store.repo.users.create({ id: 'u1', name: 'Alice', email: 'alice@x.com', createdAt: 'x', disabled: false })
  await store.repo.users.create({ id: 'u2', name: 'B', email: 'b@x.com', createdAt: 'x', disabled: false })
  await store.repo.observabilityShares.share('u1', 'u2', 'u1')
  const res = await buildApp({ authKind: 'session', userId: 'u2' }).request('/api/observability-shares/granted-to-me')
  expect(res.status).toBe(200)
  const body = await res.json() as any[]
  expect(body).toHaveLength(1)
  expect(body[0]).toMatchObject({ ownerId: 'u1', ownerEmail: 'alice@x.com', ownerName: 'Alice' })
})

test('GET granted-by-me unauthenticated → 403', async () => {
  const res = await buildApp({}).request('/api/observability-shares/granted-by-me')
  expect(res.status).toBe(403)
})

test('GET granted-to-me unauthenticated → 403', async () => {
  const res = await buildApp({}).request('/api/observability-shares/granted-to-me')
  expect(res.status).toBe(403)
})
