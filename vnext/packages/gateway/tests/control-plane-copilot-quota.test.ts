/**
 * copilot-quota control-plane tests — Week 5b.
 *
 * Per bun_mock_module_unrestorable: use setRepoForTest + globalThis.fetch
 * stub (no mock.module). Mirrors the github-accounts test wiring.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vnext-gateway/platform'
import type { GitHubAccount, Repo } from '../src/shared/repo/types.ts'
import {
  copilotQuotaRouter,
  type CopilotQuotaAuthCtx,
} from '../src/control-plane/copilot-quota/routes.ts'

function inMemoryRepo() {
  const accounts = new Map<string, GitHubAccount>()
  const activeByUser = new Map<string, number>()

  const repo = {
    github: {
      listAccounts: async () => [...accounts.values()],
      listAccountsByOwner: async (ownerId: string) =>
        [...accounts.values()].filter((a) => a.ownerId === ownerId),
      getAccount: async (userId: number, ownerId?: string) => {
        const a = accounts.get(String(userId))
        if (!a) return null
        if (ownerId && a.ownerId !== ownerId) return null
        return a
      },
      saveAccount: async (userId: number, a: GitHubAccount) => { accounts.set(String(userId), a) },
      deleteAccount: async () => { },
      deleteAllAccounts: async () => { accounts.clear() },
      getActiveId: async () => null,
      setActiveId: async () => { },
      clearActiveId: async () => { },
      getActiveIdForUser: async (ownerId: string) => activeByUser.get(ownerId) ?? null,
      setActiveIdForUser: async (ownerId: string, id: number) => { activeByUser.set(ownerId, id) },
      clearActiveIdForUser: async (ownerId: string) => { activeByUser.delete(ownerId) },
    },
  } as unknown as Repo

  return { repo, accounts, activeByUser }
}

function buildApp(auth: CopilotQuotaAuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api', copilotQuotaRouter)
  return app
}

function ghAccount(userId: number, ownerId: string, token = 'gh_token'): GitHubAccount {
  return {
    token,
    accountType: 'individual',
    user: { id: userId, login: 'alice', name: 'Alice', avatar_url: '' },
    ownerId,
    enabled: true,
    sortOrder: 0,
  } as GitHubAccount
}

let store: ReturnType<typeof inMemoryRepo>
let originalFetch: typeof fetch

beforeEach(() => {
  store = inMemoryRepo()
  initRepo(store.repo)
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === 'https://api.github.com/copilot_internal/user') {
      return new Response(JSON.stringify({ remaining: 999, quota_snapshots: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

test('GET /api/copilot-quota unauthenticated → 401', async () => {
  const res = await buildApp({}).request('/api/copilot-quota')
  expect(res.status).toBe(401)
})

test('GET /api/copilot-quota with no connected account → 404', async () => {
  const res = await buildApp({ userId: 'u1' }).request('/api/copilot-quota')
  expect(res.status).toBe(404)
})

test('GET /api/copilot-quota returns quota for active account', async () => {
  await store.repo.github.saveAccount(1, ghAccount(1, 'u1'))
  store.activeByUser.set('u1', 1)
  const res = await buildApp({ userId: 'u1' }).request('/api/copilot-quota')
  expect(res.status).toBe(200)
  const body = await res.json() as { remaining: number }
  expect(body.remaining).toBe(999)
})

test('effectiveUserId overrides userId (shared-view target)', async () => {
  await store.repo.github.saveAccount(5, ghAccount(5, 'owner'))
  store.activeByUser.set('owner', 5)
  const res = await buildApp({ userId: 'viewer', effectiveUserId: 'owner' })
    .request('/api/copilot-quota')
  expect(res.status).toBe(200)
})

test('GET /api/copilot-quota propagates GitHub error status', async () => {
  await store.repo.github.saveAccount(1, ghAccount(1, 'u1'))
  store.activeByUser.set('u1', 1)
  globalThis.fetch = (async () =>
    new Response('forbidden', { status: 403 })) as unknown as typeof fetch
  const res = await buildApp({ userId: 'u1' }).request('/api/copilot-quota')
  expect(res.status).toBe(403)
  const body = await res.json() as { error: string }
  expect(body.error).toMatch(/GitHub API error: 403/)
})

test('GET /api/admin/copilot-quota/:id requires admin', async () => {
  const res = await buildApp({ userId: 'u1' }).request('/api/admin/copilot-quota/1')
  expect(res.status).toBe(403)
})

test('GET /api/admin/copilot-quota/:id returns 404 when account missing', async () => {
  const res = await buildApp({ userId: 'admin', isAdmin: true })
    .request('/api/admin/copilot-quota/999')
  expect(res.status).toBe(404)
})

test('GET /api/admin/copilot-quota/:id returns quota for any account', async () => {
  await store.repo.github.saveAccount(7, ghAccount(7, 'u2'))
  const res = await buildApp({ userId: 'admin', isAdmin: true })
    .request('/api/admin/copilot-quota/7')
  expect(res.status).toBe(200)
  const body = await res.json() as { remaining: number }
  expect(body.remaining).toBe(999)
})
