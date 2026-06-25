/**
 * Control-plane github-accounts (mounted at /api/upstream-accounts) tests
 * — Week 5a-impl.
 *
 * Covers the single endpoint ported from old src/routes/upstream-accounts.ts.
 * Uses an in-memory Repo + a fetch shim for the api.github.com calls
 * (/user, /copilot_internal/user). The shim is installed in beforeEach and
 * restored in afterEach.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vibe-core/platform'
import type { GitHubAccount, Repo } from '../src/shared/repo/types.ts'
import {
  githubAccountsRouter,
  type ViewCtx,
} from '../src/control-plane/github-accounts/routes.ts'

function inMemoryRepo() {
  const accounts = new Map<string, GitHubAccount>()
  let activeId: number | null = null
  const activeByUser = new Map<string, number>()

  const repo = {
    github: {
      listAccounts: async () => [...accounts.values()],
      listAccountsByOwner: async (ownerId: string) =>
        [...accounts.values()].filter((a) => a.ownerId === ownerId),
      getAccount: async () => null,
      saveAccount: async (userId: number, a: GitHubAccount) => { accounts.set(String(userId), a) },
      deleteAccount: async () => { },
      deleteAllAccounts: async () => { accounts.clear() },
      getActiveId: async () => activeId,
      setActiveId: async (id: number | null) => { activeId = id },
      clearActiveId: async () => { activeId = null },
      getActiveIdForUser: async (ownerId: string) => activeByUser.get(ownerId) ?? null,
      setActiveIdForUser: async (ownerId: string, id: number) => { activeByUser.set(ownerId, id) },
      clearActiveIdForUser: async (ownerId: string) => { activeByUser.delete(ownerId) },
    },
  } as unknown as Repo

  return { repo, accounts, setActiveId: (id: number | null) => { activeId = id }, activeByUser }
}

function buildApp(auth: ViewCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api/upstream-accounts', githubAccountsRouter)
  return app
}

function ghAccount(over: Partial<GitHubAccount> & { userId?: number } = {}): GitHubAccount {
  const userId = over.userId ?? 42
  return {
    token: 'gh_token_secret',
    accountType: 'individual',
    user: { id: userId, login: 'alice', name: 'Alice', avatar_url: '' },
    ownerId: over.ownerId,
    enabled: true,
    sortOrder: 0,
    ...over,
  } as GitHubAccount
}

let store: ReturnType<typeof inMemoryRepo>
let originalFetch: typeof fetch

beforeEach(() => {
  store = inMemoryRepo()
  initRepo(store.repo)
  originalFetch = globalThis.fetch
  // Shim: /user → 200 (token valid), /copilot_internal/user → quota json
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/copilot_internal/user')) {
      return new Response(JSON.stringify({ remaining: 1234 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api.github.com/user') {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('GET /api/upstream-accounts unauthenticated → 401', async () => {
  const res = await buildApp({}).request('/api/upstream-accounts')
  expect(res.status).toBe(401)
})

test('non-admin sees only own owner accounts', async () => {
  await store.repo.github.saveAccount(1, ghAccount({ userId: 1, ownerId: 'u1' }))
  await store.repo.github.saveAccount(2, ghAccount({ userId: 2, ownerId: 'u2' }))
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/upstream-accounts')
  expect(res.status).toBe(200)
  const body = await res.json() as any[]
  expect(body).toHaveLength(1)
  expect(body[0].id).toBe('1')
  expect(body[0].token_valid).toBe(true)
  expect(body[0].quota).toEqual({ remaining: 1234 })
  // Never leak token
  expect(JSON.stringify(body[0])).not.toContain('gh_token_secret')
})

test('admin self-view sees ALL accounts', async () => {
  await store.repo.github.saveAccount(1, ghAccount({ userId: 1, ownerId: 'u1' }))
  await store.repo.github.saveAccount(2, ghAccount({ userId: 2, ownerId: 'u2' }))
  const res = await buildApp({ authKind: 'session', userId: 'admin', isAdmin: true }).request('/api/upstream-accounts')
  const body = await res.json() as any[]
  expect(body).toHaveLength(2)
  // Cross-user accounts get owner_id annotation in adminGlobalView
  expect(body.find((b) => b.id === '1').owner_id).toBe('u1')
})

test('active flag reflects activeIdForUser for non-admin', async () => {
  await store.repo.github.saveAccount(1, ghAccount({ userId: 1, ownerId: 'u1' }))
  await store.repo.github.saveAccount(2, ghAccount({ userId: 2, ownerId: 'u1' }))
  store.activeByUser.set('u1', 2)
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/upstream-accounts')
  const body = await res.json() as any[]
  const a1 = body.find((b) => b.id === '1')
  const a2 = body.find((b) => b.id === '2')
  expect(a1.active).toBe(false)
  expect(a2.active).toBe(true)
})

test('avatar_url falls back to githubusercontent template', async () => {
  await store.repo.github.saveAccount(7, ghAccount({ userId: 7, ownerId: 'u1' }))
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/upstream-accounts')
  const body = await res.json() as any[]
  expect(body[0].avatar_url).toBe('https://avatars.githubusercontent.com/u/7?v=4')
})

test('effectiveUserId overrides userId (shared-view target)', async () => {
  await store.repo.github.saveAccount(1, ghAccount({ userId: 1, ownerId: 'owner' }))
  const res = await buildApp({
    authKind: 'session', userId: 'viewer', effectiveUserId: 'owner', isViewingShared: true, ownerId: 'owner',
  }).request('/api/upstream-accounts')
  const body = await res.json() as any[]
  expect(body).toHaveLength(1)
  expect(body[0].id).toBe('1')
})

test('token_valid is false when GitHub returns 401', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === 'https://api.github.com/user') return new Response('unauth', { status: 401 })
    return new Response('null', { status: 404 })
  }) as unknown as typeof fetch
  await store.repo.github.saveAccount(1, ghAccount({ userId: 1, ownerId: 'u1' }))
  const res = await buildApp({ authKind: 'session', userId: 'u1' }).request('/api/upstream-accounts')
  const body = await res.json() as any[]
  expect(body[0].token_valid).toBe(false)
  expect(body[0].quota).toBeNull()
})
