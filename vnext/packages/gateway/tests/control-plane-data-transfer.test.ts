/**
 * data-transfer control-plane tests — Week 5b.
 *
 * Real in-memory SQLite repo (setupTestPlatform). Covers admin-gate, export redact, import
 * mode validation, parse errors, merge vs replace, and REDACTED restore via
 * unredactWithLive.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { setupTestPlatform } from './_setup-platform.ts'
import type { ApiKeyId, GitHubAccountId } from '../src/repo/branded-ids.ts'
import type {
  ApiKey,
  GitHubAccount,
  UpstreamRecord,
} from '../src/repo/types.ts'
import {
  dataTransferRouter,
  type DataTransferAuthCtx,
} from '../src/control-plane/data-transfer/routes.ts'
import { REDACTED } from '../src/control-plane/lib/import-export.ts'

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
  return { id, name: id, key, createdAt: '2026-01-01T00:00:00Z', modelMappingsEnabled: false, modelMappings: [] }
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

let repo: ReturnType<typeof setupTestPlatform>['repo']

beforeEach(() => {
  ;({ repo } = setupTestPlatform())
})

const account = async (id: number) =>
  (await repo.github.listAccounts()).find((a) => a.user.id === id)
const upstream = async (id: string) =>
  (await repo.upstreams.list({ includeDisabled: true })).find((u) => u.id === id)

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
  await repo.apiKeys.save(mkKey('k1', 'secret-key'))
  await repo.github.saveAccount(1 as GitHubAccountId, mkAccount(1, 'gh-token'))
  await repo.upstreams.save(mkUpstream('u1', 'up-secret'))

  const res = await buildApp({ isAdmin: true }).request('/api/export')
  expect(res.status).toBe(200)
  const body = await res.json() as { apiKeys: ApiKey[]; githubAccounts: GitHubAccount[]; upstreams: UpstreamRecord[]; version: number }
  expect(body.version).toBe(2)
  expect(body.apiKeys[0].key).toBe('secret-key')
  expect(body.githubAccounts[0].token).toBe('gh-token')
  expect(body.upstreams[0].config.apiKey).toBe('up-secret')
})

test('GET /api/export?redact=1 hides secrets', async () => {
  // Every per-engine web-search credential is a secret too, not just the API
  // key itself — an export that leaks one is as bad as leaking the key.
  await repo.apiKeys.save({
    ...mkKey('k1', 'secret-key'),
    webSearchLangsearchKey: 'ls-secret',
    webSearchTavilyKey: 'tv-secret',
    webSearchMsGroundingKey: 'ms-secret',
    webSearchJinaKey: 'jn-secret',
  })
  await repo.github.saveAccount(1 as GitHubAccountId, mkAccount(1, 'gh-token'))
  await repo.upstreams.save(mkUpstream('u1', 'up-secret'))

  const res = await buildApp({ isAdmin: true }).request('/api/export?redact=1')
  const body = await res.json() as { apiKeys: ApiKey[]; githubAccounts: GitHubAccount[]; upstreams: UpstreamRecord[] }
  expect(body.apiKeys[0].key).toBe(REDACTED)
  expect(body.apiKeys[0].webSearchLangsearchKey).toBe(REDACTED)
  expect(body.apiKeys[0].webSearchTavilyKey).toBe(REDACTED)
  expect(body.apiKeys[0].webSearchMsGroundingKey).toBe(REDACTED)
  expect(body.apiKeys[0].webSearchJinaKey).toBe(REDACTED)
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
  await repo.apiKeys.save(mkKey('existing', 'live-secret'))

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
  expect(await repo.apiKeys.list()).toHaveLength(2)
  expect((await repo.apiKeys.getById('existing' as ApiKeyId))!.key).toBe('live-secret')
  expect((await repo.apiKeys.getById('new' as ApiKeyId))!.key).toBe('new-secret')
})

test('POST /api/import replace deletes existing first', async () => {
  await repo.apiKeys.save(mkKey('old', 'old-secret'))
  await repo.github.saveAccount(99 as GitHubAccountId, mkAccount(99, 'old-token'))

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
  expect(await repo.apiKeys.list()).toHaveLength(1)
  expect(await repo.apiKeys.getById('old' as ApiKeyId)).toBeNull()
  expect((await repo.apiKeys.getById('fresh' as ApiKeyId))!.key).toBe('fresh-secret')
  expect(await repo.github.listAccounts()).toHaveLength(0)
})

test('POST /api/import restores REDACTED secrets from live state', async () => {
  await repo.apiKeys.save(mkKey('k1', 'live-secret'))
  await repo.github.saveAccount(1 as GitHubAccountId, mkAccount(1, 'live-token'))
  await repo.upstreams.save(mkUpstream('u1', 'live-up-secret'))

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
  expect((await repo.apiKeys.getById('k1' as ApiKeyId))!.key).toBe('live-secret')
  expect((await repo.apiKeys.getById('k1' as ApiKeyId))!.name).toBe('updated-name')
  expect((await account(1))!.token).toBe('live-token')
  expect((await account(1))!.accountType).toBe('business')
  expect((await upstream('u1'))!.config.apiKey).toBe('live-up-secret')
  expect((await upstream('u1'))!.name).toBe('updated-upstream')
})
