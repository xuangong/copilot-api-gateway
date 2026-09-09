import { expect, test } from 'bun:test'
import { setupTestPlatform } from '../_setup-platform.ts'
import { getDataPlaneRepo } from '../../src/repo/index.ts'
import { ensureCodexAccessToken, CodexOAuthSessionTerminatedError, putCodexQuota, readCodexUpstreamState } from '@vibe-llm/provider-codex'
import { ensureClaudeCodeAccessToken, putClaudeCodeQuota, readClaudeCodeUpstreamState, parseClaudeCodeQuotaHeaders } from '@vibe-llm/provider-claude-code'
import { refreshModelsCache, listUpstreamModels } from '../../src/data-plane/providers/registry.ts'
import type { LlmModelProvider } from '@vibe-llm/provider-llm'

const accountId = '00000000-0000-4000-8000-000000000001'
const codexState = () => readCodexUpstreamState({ accounts: [{ chatgptAccountId: accountId, refresh_token: 'old-refresh', state: 'active', state_updated_at: '2026-01-01', openaiDeviceId: accountId, accessToken: null, quotaSnapshot: null }] })
const claudeState = () => readClaudeCodeUpstreamState({ accounts: [{ accountUuid: accountId, tokenKind: 'oauth', refreshToken: 'old-refresh', state: 'active', stateUpdatedAt: '2026-01-01', accessToken: null, quotaSnapshot: null, usageProbeSnapshot: null }] })
const row = (provider: string, state: unknown) => ({
  id: provider, provider, name: provider, enabled: true, sortOrder: 0,
  config: { accounts: [provider === 'codex' ? { chatgptAccountId: accountId, email: 'fixture@example.test', chatgptUserId: 'fixture', planType: 'plus' } : { accountUuid: accountId, email: null, subscriptionType: 'max', organizationUuid: null, rateLimitTier: null }] },
  state, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: 'direct_fetch' }],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
})

for (const siblingHasAccessToken of [true, false]) test(`Codex refresh race rereads authoritative rotated credentials (cached access: ${siblingHasAccessToken})`, async () => {
  const { repo, db } = setupTestPlatform()
  const state = codexState()
  await repo.upstreams.save(row('codex', state) as never)
  await getDataPlaneRepo().upstreams.getById('codex')
  const minted = { token: 'winner-access', expiresAt: Date.now() + 3_600_000, refreshedAt: new Date().toISOString() }
  const calls: string[] = []
  try {
    const result = await ensureCodexAccessToken('codex', accountId, async refresh => {
      calls.push(refresh)
      if (refresh === 'old-refresh') {
        const winner = codexState()
        const account = winner.accounts[0]
        if (!account) throw new Error('missing fixture account')
        account.refresh_token = 'winner-refresh'
        account.accessToken = siblingHasAccessToken ? minted : null
        // Direct SQL models a sibling instance, bypassing local invalidation.
        db.query('UPDATE upstreams SET state_json = ? WHERE id = ?').run(JSON.stringify(winner), 'codex')
        throw new CodexOAuthSessionTerminatedError({ code: 'invalid_grant', message: 'fixture rotation' })
      }
      return minted
    })
    expect(result.token).toBe('winner-access')
    expect(calls).toEqual(siblingHasAccessToken ? ['old-refresh'] : ['old-refresh', 'winner-refresh'])
  } finally { db.close() }
})

test('Claude refresh race reads the authoritative sibling token without terminalizing the account', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.upstreams.save(row('claude-code', claudeState()) as never)
  await getDataPlaneRepo().upstreams.getById('claude-code')
  try {
    const result = await ensureClaudeCodeAccessToken({ upstreamId: 'claude-code', fetcher: async () => {
      const winner = claudeState()
      const account = winner.accounts[0]
      if (!account) throw new Error('missing fixture account')
      account.refreshToken = 'winner-refresh'
      account.accessToken = { token: 'winner-access', expiresAt: Date.now() + 3_600_000, refreshedAt: new Date().toISOString() }
      db.query('UPDATE upstreams SET state_json = ? WHERE id = ?').run(JSON.stringify(winner), 'claude-code')
      return Response.json({ error: 'invalid_grant', error_description: 'fixture rotation' }, { status: 400 })
    } })
    expect(result.entry.token).toBe('winner-access')
    const current = await repo.upstreams.getById<ReturnType<typeof claudeState>>('claude-code')
    expect(current?.state?.accounts[0]?.state).toBe('active')
  } finally { db.close() }
})

for (const provider of ['codex', 'claude-code']) test(`${provider} quota writes update one row and retain warm configuration and catalogs`, async () => {
  const { repo, db } = setupTestPlatform()
  const originalFetch = globalThis.fetch
  try {
    await repo.upstreams.save(row(provider, provider === 'codex' ? codexState() : claudeState()) as never)
    const view = getDataPlaneRepo()
    const upstream = await view.upstreams.getById(provider)
    if (!upstream) throw new Error('missing fixture upstream')
    await refreshModelsCache(upstream, { getModels: async () => ({ object: 'list', data: [{ id: 'fixture-model', object: 'model', capabilities: { type: 'chat' } }] }) } as unknown as LlmModelProvider)
    const revision = await repo.configurationRevision!()
    if (provider === 'codex') await putCodexQuota(provider, accountId, { observed_at: new Date().toISOString(), primary_used_percent: 20 })
    else await putClaudeCodeQuota(provider, parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-status': 'allowed' })))
    expect(await repo.configurationRevision!()).toBe(revision)
    const executor = (repo.apiKeys as unknown as { x: Record<string, (...args: unknown[]) => unknown> }).x
    let reads = 0
    let requests = 0
    for (const method of ['first', 'all']) {
      const original = executor[method]
      if (!original) throw new Error('missing SQL method')
      executor[method] = (...args) => { reads++; return original.apply(executor, args) }
    }
    globalThis.fetch = (async () => { requests++; throw new Error('unexpected auxiliary HTTP') }) as typeof fetch
    await view.apiKeys.list()
    const fresh = await view.upstreams.getById<{ accounts: { quotaSnapshot: unknown }[] }>(provider)
    expect(fresh?.state?.accounts[0]?.quotaSnapshot).not.toBeNull()
    const catalog = await listUpstreamModels({ strictCatalog: true })
    expect(catalog.data.map(m => m.id)).toEqual(['fixture-model'])
    expect(reads).toBe(0)
    expect(requests).toBe(0)
  } finally { globalThis.fetch = originalFetch; db.close() }
})

for (const sameUpstream of [false, true]) test(`concurrent state writes retain hot configuration (same upstream: ${sameUpstream})`, async () => {
  const { repo, db } = setupTestPlatform()
  await repo.upstreams.save(row('codex', codexState()) as never)
  await repo.upstreams.save(row('claude-code', claudeState()) as never)
  const view = getDataPlaneRepo()
  await view.upstreams.list()
  const getById = repo.upstreams.getById.bind(repo.upstreams)
  let reads = 0
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  repo.upstreams.getById = async id => {
    const value = await getById(id)
    if (++reads === 2) release()
    await gate
    return value as never
  }
  try {
    await Promise.all([
      putCodexQuota('codex', accountId, { observed_at: new Date().toISOString(), primary_used_percent: 10 }),
      sameUpstream
        ? putCodexQuota('codex', accountId, { observed_at: new Date().toISOString(), secondary_used_percent: 20 })
        : putClaudeCodeQuota('claude-code', parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-status': 'allowed' }))),
    ])
    repo.upstreams.getById = getById
    const list = repo.apiKeys.list.bind(repo.apiKeys)
    let reloads = 0
    repo.apiKeys.list = async () => { reloads++; return list() }
    await view.apiKeys.list()
    const updated = await view.upstreams.getById<{ accounts: { quotaSnapshot: unknown }[] }>('codex')
    expect(updated?.state?.accounts[0]?.quotaSnapshot).not.toBeNull()
    expect(reloads).toBe(0)
  } finally { repo.upstreams.getById = getById; db.close() }
})

import { ConfigurationCache } from '../../src/repo/configuration-cache.ts'
import { initBackground } from '@vibe-core/platform'

test('remote quota changes refresh in background without configuration revision churn', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.upstreams.save(row('codex', codexState()) as never)
  let now = 0
  const cache = new ConfigurationCache(repo, () => now)
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: p => { pending.push(p) } })
  await cache.view.upstreams.getById('codex')
  const revision = await repo.configurationRevision!()
  const state = codexState()
  const account = state.accounts[0]
  if (!account) throw new Error('missing fixture account')
  account.quotaSnapshot = { unknown: { fetchedAt: Date.now(), data: { observed_at: new Date().toISOString(), primary_used_percent: 90 } } }
  db.query('UPDATE upstreams SET state_json = ? WHERE id = ?').run(JSON.stringify(state), 'codex')
  expect(await repo.configurationRevision!()).toBe(revision)
  now = 31_000
  await cache.view.upstreams.getById('codex')
  await Promise.all(pending)
  const refreshed = await cache.view.upstreams.getById<ReturnType<typeof codexState>>('codex')
  expect(refreshed?.state?.accounts[0]?.quotaSnapshot?.unknown?.data.primary_used_percent).toBe(90)
  db.close()
})

test('state write discovering remote proxy references reloads one coherent configuration', async () => {
  const { repo, db } = setupTestPlatform()
  await repo.upstreams.save(row('codex', codexState()) as never)
  const view = getDataPlaneRepo()
  await view.upstreams.list()
  // Same DB, bypass local mutation hooks to model another instance's edit.
  db.query("INSERT INTO proxies (id, name, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run('remote-proxy', 'remote', 'http://localhost:1234', '2026-01-01', '2026-01-01')
  db.query('UPDATE upstreams SET proxy_fallback_list_json = ? WHERE id = ?').run(JSON.stringify([{ id: 'remote-proxy' }]), 'codex')
  await putCodexQuota('codex', accountId, { observed_at: new Date().toISOString() })
  expect((await view.proxies.getById('remote-proxy'))?.id).toBe('remote-proxy')
  expect((await view.upstreams.getById('codex'))?.proxyFallbackList).toEqual([{ id: 'remote-proxy' }])
  db.close()
})
