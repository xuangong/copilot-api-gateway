import { expect, test } from 'bun:test'
import { setupTestPlatform } from './_setup-platform.ts'
import { getDataPlaneRepo } from '../src/repo/index.ts'

test('warm key and owner configuration is shared without SQL and updates after local rotation', async () => {
  const { repo, db } = setupTestPlatform()
  const key = { id: 'key-1', name: 'one', key: 'first', createdAt: '2026-09-09', ownerId: 'owner', modelMappingsEnabled: false, modelMappings: [] }
  await repo.apiKeys.save(key as never)
  await repo.apiKeys.save({ ...key, id: 'key-2', key: 'second' } as never)
  const view = getDataPlaneRepo()
  expect((await view.apiKeys.findByRawKey('first'))?.id).toBe('key-1')
  const executor = (repo.apiKeys as unknown as { x: { all: (...args: unknown[]) => unknown; first: (...args: unknown[]) => unknown } }).x
  const originals = { all: executor.all, first: executor.first }
  let reads = 0
  executor.all = function (...args: unknown[]) { reads++; return originals.all.apply(this, args) }
  executor.first = function (...args: unknown[]) { reads++; return originals.first.apply(this, args) }
  expect((await view.apiKeys.findByRawKey('second'))?.ownerId).toBe('owner')
  await view.apiKeys.getById('key-1' as never)
  await view.upstreams.list({ ownerId: 'owner' as never })
  await view.proxies.list()
  expect(reads).toBe(0)
  await repo.apiKeys.save({ ...key, key: 'rotated' } as never)
  expect(await view.apiKeys.findByRawKey('first')).toBeNull()
  expect((await view.apiKeys.findByRawKey('rotated'))?.id).toBe('key-1')
  db.close()
})

import { ConfigurationCache, CONFIG_AUTH_LEASE_MS } from '../src/repo/configuration-cache.ts'
import { initBackground } from '@vibe-core/platform'

const fixtureKey = { id: 'key', name: 'fixture', key: 'fixture', createdAt: '2026-09-09', modelMappingsEnabled: false, modelMappings: [] }

test('another process deletion is discovered in background without dropping the current snapshot prematurely', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.apiKeys.save(fixtureKey as never)
  let now = 0
  const cache = new ConfigurationCache(repo, () => now)
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: p => { pending.push(p) } })
  await cache.view.apiKeys.findByRawKey('fixture')
  db.exec("DELETE FROM api_keys WHERE id = 'key'")
  now = 31_000
  expect((await cache.view.apiKeys.findByRawKey('fixture'))?.id).toBe('key')
  await Promise.all(pending)
  expect(await cache.view.apiKeys.findByRawKey('fixture')).toBeNull()
  db.close()
})

test('failed background check preserves data but expired authorization lease fails closed', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.apiKeys.save(fixtureKey as never)
  let now = 0
  const cache = new ConfigurationCache(repo, () => now)
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: p => { pending.push(p) } })
  await cache.view.apiKeys.findByRawKey('fixture')
  const revision = repo.configurationRevision!
  repo.configurationRevision = async () => { throw new Error('unavailable') }
  now = 31_000
  expect((await cache.view.apiKeys.findByRawKey('fixture'))?.id).toBe('key')
  await Promise.all(pending)
  now = CONFIG_AUTH_LEASE_MS + 1
  await expect(cache.view.apiKeys.findByRawKey('fixture')).rejects.toThrow('temporarily unavailable')
  repo.configurationRevision = revision
  expect((await cache.view.apiKeys.findByRawKey('fixture'))?.id).toBe('key')
  db.close()
})

test('a concurrent mutation cannot publish an old load over the newer configuration', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.apiKeys.save(fixtureKey as never)
  const cache = new ConfigurationCache(repo)
  const list = repo.apiKeys.list.bind(repo.apiKeys)
  let release!: () => void
  let loaded!: () => void
  const gate = new Promise<void>(r => { release = r })
  const started = new Promise<void>(r => { loaded = r })
  let first = true
  repo.apiKeys.list = async () => {
    const rows = await list()
    if (first) { first = false; loaded(); await gate }
    return rows
  }
  const read = cache.view.apiKeys.findByRawKey('fixture')
  await started
  await repo.apiKeys.save({ ...fixtureKey, key: 'rotated' } as never)
  cache.invalidate()
  release()
  expect(await read).toBeNull()
  expect((await cache.view.apiKeys.findByRawKey('rotated'))?.id).toBe('key')
  db.close()
})

test('snapshots are isolated from caller mutation and stay pinned across local changes', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.apiKeys.save(fixtureKey as never)
  const cache = new ConfigurationCache(repo)
  const pinned = await cache.pinnedView()
  const key = await pinned.apiKeys.findByRawKey('fixture')
  key!.modelMappings.push({ source: 'injected', destination: 'other' })
  expect((await pinned.apiKeys.findByRawKey('fixture'))!.modelMappings).toEqual([])
  await repo.apiKeys.delete('key' as never)
  cache.invalidate()
  expect(await cache.view.apiKeys.findByRawKey('fixture')).toBeNull()
  expect((await pinned.apiKeys.findByRawKey('fixture'))?.id).toBe('key')
  db.close()
})

test('usage timestamps do not change configuration revision; proxy changes do', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.apiKeys.save(fixtureKey as never)
  const revision = await repo.configurationRevision!()
  await repo.apiKeys.touchLastUsed('key' as never)
  expect(await repo.configurationRevision!()).toBe(revision)
  await repo.proxies.insert({ id: 'proxy', name: 'proxy', url: 'http://localhost:1234', dialTimeoutSeconds: null })
  await repo.proxies.patch('proxy', { name: 'changed' })
  expect(await repo.configurationRevision!()).toBe(revision + 2)
  db.close()
})

test('warm proxy health checks and already healthy successful dials do not touch storage', async () => {
  const { repo, db } = setupTestPlatform()
  const view = getDataPlaneRepo()
  await view.proxyBackoffs.listForUpstream('upstream')
  const executor = (repo.apiKeys as unknown as { x: Record<string, (...args: unknown[]) => unknown> }).x
  const originalAll = executor.all!
  const originalRun = executor.run!
  let calls = 0
  executor.all = (...args) => { calls++; return originalAll.apply(executor, args) }
  executor.run = (...args) => { calls++; return originalRun.apply(executor, args) }
  await view.proxyBackoffs.listForUpstream('upstream')
  await view.proxyBackoffs.recordDialSuccess('proxy', 'upstream')
  expect(calls).toBe(0)
  db.close()
})

test('session authentication reuses a bounded entry and invalidates on logout', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.users.create({ id: 'user', name: 'user', createdAt: '2026-09-09', disabled: false } as never)
  await repo.sessions.create({ token: 'ses_fixture', userId: 'user', createdAt: '2026-09-09', expiresAt: '2099-01-01' } as never)
  const view = getDataPlaneRepo()
  expect((await view.sessions.findByToken('ses_fixture' as never))?.userId).toBe('user')
  const executor = (repo.apiKeys as unknown as { x: Record<string, (...args: unknown[]) => unknown> }).x
  const original = executor.first!
  let calls = 0
  executor.first = (...args) => { calls++; return original.apply(executor, args) }
  await view.sessions.findByToken('ses_fixture' as never)
  await view.users.getById('user' as never)
  expect(calls).toBe(0)
  await repo.sessions.deleteByUserId('user' as never)
  expect(await view.sessions.findByToken('ses_fixture' as never)).toBeNull()
  db.close()
})

test('remote session logout is discovered without a session table scan', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.users.create({ id: 'user', name: 'user', createdAt: '2026-09-09', disabled: false } as never)
  await repo.sessions.create({ token: 'ses_remote', userId: 'user', createdAt: '2026-09-09', expiresAt: '2099-01-01' } as never)
  let now = 0
  const cache = new ConfigurationCache(repo, () => now)
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: p => { pending.push(p) } })
  expect(await cache.view.sessions.findByToken('ses_remote' as never)).not.toBeNull()
  db.exec("DELETE FROM user_sessions WHERE token = 'ses_remote'")
  now = 31_000
  await cache.view.sessions.findByToken('ses_remote' as never)
  await Promise.all(pending)
  expect(await cache.view.sessions.findByToken('ses_remote' as never)).toBeNull()
  db.close()
})

import { Hono } from 'hono'
import { withConfigurationSnapshot } from '../src/repo/index.ts'
import { validateApiKey } from '../src/control-plane/lib/api-keys.ts'
import { sessionAuthMiddleware } from '../src/control-plane/auth/session-auth.ts'
import { devAuthMiddleware } from '../src/control-plane/auth/dev-auth.ts'

test('control-plane authentication reads authoritative keys and sessions', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.apiKeys.save(fixtureKey as never)
  await getDataPlaneRepo().apiKeys.findByRawKey('fixture')
  db.exec("DELETE FROM api_keys WHERE id = 'key'")
  expect(await validateApiKey('fixture')).toBeNull()
  await repo.users.create({ id: 'user', name: 'user', createdAt: '2026-09-09', disabled: false } as never)
  await repo.sessions.create({ token: 'ses_control', userId: 'user', createdAt: '2026-09-09', expiresAt: '2099-01-01' } as never)
  await getDataPlaneRepo().sessions.findByToken('ses_control' as never)
  db.exec("DELETE FROM user_sessions WHERE token = 'ses_control'")
  const app = new Hono()
  app.use('*', sessionAuthMiddleware)
  app.get('/', c => c.json({ authenticated: Boolean(c.get('auth' as never)) }))
  const response = await app.request('/', { headers: { authorization: 'Bearer ses_control' } })
  expect(await response.json()).toEqual({ authenticated: false })
  db.close()
})

test('explicit development auth still accepts smoke test bearer after snapshot middleware', async () => {
  const { db } = setupTestPlatform()
  const previous = { env: process.env.NODE_ENV, token: process.env.VNEXT_DEV_COPILOT_TOKEN }
  try {
    process.env.NODE_ENV = 'test'
    process.env.VNEXT_DEV_COPILOT_TOKEN = 'fixture-dev-token'
    const app = new Hono()
    app.use('*', (_c, next) => withConfigurationSnapshot(next))
    app.use('*', sessionAuthMiddleware, devAuthMiddleware)
    app.get('/', c => c.json({ authenticated: Boolean(c.get('auth' as never)) }))
    const response = await app.request('/', { headers: { authorization: 'Bearer bogus-smoke-key' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ authenticated: true })
  } finally {
    if (previous.env === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous.env
    if (previous.token === undefined) delete process.env.VNEXT_DEV_COPILOT_TOKEN
    else process.env.VNEXT_DEV_COPILOT_TOKEN = previous.token
    db.close()
  }
})

import { app as gatewayApp } from '../src/app.ts'

test('real management model route does not pin stale session authorization', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.users.create({ id: 'user', name: 'user', email: 'test@local.dev', createdAt: '2026-09-09', disabled: false } as never)
  await repo.sessions.create({ token: 'ses_management', userId: 'user', createdAt: '2026-09-09', expiresAt: '2099-01-01' } as never)
  await getDataPlaneRepo().sessions.findByToken('ses_management' as never)
  db.exec("DELETE FROM user_sessions WHERE token = 'ses_management'")
  const findSession = repo.sessions.findByToken.bind(repo.sessions)
  let authoritativeReads = 0
  repo.sessions.findByToken = async token => { authoritativeReads++; return findSession(token) }
  const response = await gatewayApp.request('/api/upstreams/missing/models', { headers: { authorization: 'Bearer ses_management' } })
  expect(authoritativeReads).toBe(1)
  expect(response.status).toBe(404)
  await response.text()
  db.close()
})

test('session cache evicts least recently used entries beyond its capacity', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.users.create({ id: 'user', name: 'user', createdAt: '2026-09-09', disabled: false } as never)
  for (let i = 0; i < 513; i++) await repo.sessions.create({ token: `ses_${i}`, userId: 'user', createdAt: '2026-09-09', expiresAt: '2099-01-01' } as never)
  const cache = new ConfigurationCache(repo)
  for (let i = 0; i < 513; i++) await cache.view.sessions.findByToken(`ses_${i}` as never)
  const find = repo.sessions.findByToken.bind(repo.sessions)
  let reads = 0
  repo.sessions.findByToken = async token => { reads++; return find(token) }
  await cache.view.sessions.findByToken('ses_512' as never)
  expect(reads).toBe(0)
  await cache.view.sessions.findByToken('ses_0' as never)
  expect(reads).toBe(1)
  db.close()
})

test('failed advisory row refresh retains the confirmed configuration', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.upstreams.save({ id: 'advisory', provider: 'custom', name: 'advisory', enabled: true, sortOrder: 0, config: {}, state: null, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' } as never)
  let now = 0
  const cache = new ConfigurationCache(repo, () => now)
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: p => { pending.push(p) } })
  await cache.view.upstreams.getById('advisory')
  repo.upstreams.getById = async () => { throw new Error('advisory read unavailable') }
  now = 31_000
  await cache.view.upstreams.getById('advisory')
  await Promise.all(pending)
  // The version check succeeded; a telemetry read failure must not force the
  // next request back into a full configuration load.
  repo.configurationRevision = async () => { throw new Error('version probe should not run again') }
  expect((await cache.view.upstreams.getById('advisory'))?.id).toBe('advisory')
  db.close()
})
