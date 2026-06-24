/**
 * data-transfer control-plane tests — Week 5b.
 *
 * In-memory repo + setRepoForTest. Covers admin-gate, export redact, import
 * mode validation, parse errors, merge vs replace, and REDACTED restore via
 * unredactWithLive.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vnext-gateway/platform'
import type {
  ApiKey,
  GitHubAccount,
  Repo,
  UpstreamRecord,
} from '../src/shared/repo/types.ts'
import {
  dataTransferRouter,
  type DataTransferAuthCtx,
} from '../src/control-plane/data-transfer/routes.ts'
import { REDACTED } from '../src/shared/lib/import-export.ts'

function inMemoryRepo() {
  const apiKeys = new Map<string, ApiKey>()
  const accounts = new Map<number, GitHubAccount>()
  const upstreams = new Map<string, UpstreamRecord>()

  const repo = {
    apiKeys: {
      list: async () => [...apiKeys.values()],
      save: async (k: ApiKey) => { apiKeys.set(k.id, k) },
      deleteAll: async () => { apiKeys.clear() },
    },
    github: {
      listAccounts: async () => [...accounts.values()],
      saveAccount: async (userId: number, a: GitHubAccount) => { accounts.set(userId, a) },
      deleteAllAccounts: async () => { accounts.clear() },
    },
    upstreams: {
      list: async (_opts?: { includeDisabled?: boolean }) => [...upstreams.values()],
      save: async (u: UpstreamRecord) => { upstreams.set(u.id, u) },
      deleteAll: async () => { upstreams.clear() },
    },
  } as unknown as Repo

  return { repo, apiKeys, accounts, upstreams }
}

function buildApp(auth: DataTransferAuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api', dataTransferRouter)
  return app
}

function mkKey(id: string, key: string): ApiKey {
  return { id, name: id, key, createdAt: '2026-01-01T00:00:00Z' }
}

function mkAccount(userId: number, token: string): GitHubAccount {
  return {
    token,
    accountType: 'individual',
    user: { id: userId, login: `u${userId}`, name: null, avatar_url: '' },
  }
}

function mkUpstream(id: string, secretToken: string): UpstreamRecord {
  return {
    id, provider: 'custom', name: id, enabled: true, sortOrder: 0,
    config: { baseUrl: 'http://x', apiKey: secretToken },
    flagOverrides: {}, disabledPublicModelIds: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }
}

let store: ReturnType<typeof inMemoryRepo>

beforeEach(() => {
  store = inMemoryRepo()
  initRepo(store.repo)
})

afterEach(() => {
  __resetPlatformForTests()
})

test('GET /api/export non-admin → 403', async () => {
  const res = await buildApp({}).request('/api/export')
  expect(res.status).toBe(403)
})

test('POST /api/import non-admin → 403', async () => {
  const res = await buildApp({}).request('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'merge', bundle: {} }),
  })
  expect(res.status).toBe(403)
})

test('GET /api/export raw returns live secrets', async () => {
  store.apiKeys.set('k1', mkKey('k1', 'secret-key'))
  store.accounts.set(1, mkAccount(1, 'gh-token'))
  store.upstreams.set('u1', mkUpstream('u1', 'up-secret'))

  const res = await buildApp({ isAdmin: true }).request('/api/export')
  expect(res.status).toBe(200)
  const body = await res.json() as { apiKeys: ApiKey[]; githubAccounts: GitHubAccount[]; upstreams: UpstreamRecord[]; version: number }
  expect(body.version).toBe(2)
  expect(body.apiKeys[0].key).toBe('secret-key')
  expect(body.githubAccounts[0].token).toBe('gh-token')
  expect(body.upstreams[0].config.apiKey).toBe('up-secret')
})

test('GET /api/export?redact=1 hides secrets', async () => {
  store.apiKeys.set('k1', mkKey('k1', 'secret-key'))
  store.accounts.set(1, mkAccount(1, 'gh-token'))
  store.upstreams.set('u1', mkUpstream('u1', 'up-secret'))

  const res = await buildApp({ isAdmin: true }).request('/api/export?redact=1')
  const body = await res.json() as { apiKeys: ApiKey[]; githubAccounts: GitHubAccount[]; upstreams: UpstreamRecord[] }
  expect(body.apiKeys[0].key).toBe(REDACTED)
  expect(body.githubAccounts[0].token).toBe(REDACTED)
  expect(body.upstreams[0].config.apiKey).toBe(REDACTED)
})

test('POST /api/import bad mode → 400', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'wat', bundle: { version: 2, apiKeys: [], githubAccounts: [] } }),
  })
  expect(res.status).toBe(400)
})

test('POST /api/import malformed bundle → 400', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'merge', bundle: { foo: 'bar' } }),
  })
  expect(res.status).toBe(400)
})

test('POST /api/import merge keeps existing + adds new', async () => {
  store.apiKeys.set('existing', mkKey('existing', 'live-secret'))

  const res = await buildApp({ isAdmin: true }).request('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'merge',
      bundle: {
        version: 2,
        exportedAt: '2026-03-01T00:00:00Z',
        apiKeys: [mkKey('new', 'new-secret')],
        githubAccounts: [],
        upstreams: [],
      },
    }),
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { ok: boolean; imported: { apiKeys: number } }
  expect(body.ok).toBe(true)
  expect(body.imported.apiKeys).toBe(1)
  expect(store.apiKeys.size).toBe(2)
  expect(store.apiKeys.get('existing')!.key).toBe('live-secret')
  expect(store.apiKeys.get('new')!.key).toBe('new-secret')
})

test('POST /api/import replace deletes existing first', async () => {
  store.apiKeys.set('old', mkKey('old', 'old-secret'))
  store.accounts.set(99, mkAccount(99, 'old-token'))

  const res = await buildApp({ isAdmin: true }).request('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'replace',
      bundle: {
        version: 2,
        exportedAt: '',
        apiKeys: [mkKey('fresh', 'fresh-secret')],
        githubAccounts: [],
        upstreams: [],
      },
    }),
  })
  expect(res.status).toBe(200)
  expect(store.apiKeys.size).toBe(1)
  expect(store.apiKeys.has('old')).toBe(false)
  expect(store.apiKeys.get('fresh')!.key).toBe('fresh-secret')
  expect(store.accounts.size).toBe(0)
})

test('POST /api/import restores REDACTED secrets from live state', async () => {
  store.apiKeys.set('k1', mkKey('k1', 'live-secret'))
  store.accounts.set(1, mkAccount(1, 'live-token'))
  store.upstreams.set('u1', mkUpstream('u1', 'live-up-secret'))

  const redactedBundle = {
    version: 2,
    exportedAt: '',
    apiKeys: [{ ...mkKey('k1', REDACTED), name: 'updated-name' }],
    githubAccounts: [{ ...mkAccount(1, REDACTED), accountType: 'business' }],
    upstreams: [{ ...mkUpstream('u1', REDACTED), name: 'updated-upstream' }],
  }

  const res = await buildApp({ isAdmin: true }).request('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'merge', bundle: redactedBundle }),
  })
  const body = await res.json() as { redactedCount: number }
  expect(res.status).toBe(200)
  expect(body.redactedCount).toBe(3) // apiKey + token + upstream.config.apiKey
  // Live secrets restored
  expect(store.apiKeys.get('k1')!.key).toBe('live-secret')
  expect(store.apiKeys.get('k1')!.name).toBe('updated-name')
  expect(store.accounts.get(1)!.token).toBe('live-token')
  expect(store.accounts.get(1)!.accountType).toBe('business')
  expect(store.upstreams.get('u1')!.config.apiKey).toBe('live-up-secret')
  expect(store.upstreams.get('u1')!.name).toBe('updated-upstream')
})
