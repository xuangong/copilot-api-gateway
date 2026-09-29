import { D1Repo } from '__ROOT__/vnext/apps/platform-cloudflare/src/d1-repo.ts'
import { initUpstreamRepo } from '__ROOT__/vnext/packages/upstream-repo/src/index.ts'
import { ensureCodexAccessToken } from '__ROOT__/vnext/packages/provider-codex/src/access-token.ts'
export default { async fetch(_request, env) {
  const repo = new D1Repo(env.DB), sibling = new D1Repo(env.DB)
  initUpstreamRepo(() => repo.upstreams)
  const now = new Date().toISOString(), future = Date.now() + 3600_000
  const access = token => ({ token, expiresAt: future, refreshedAt: now })
  const account = { chatgptAccountId: 'synthetic-account', refresh_token: 'synthetic-old-refresh', state: 'active', state_updated_at: now, openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: null, quotaSnapshot: null }
  await repo.upstreams.save({ id: 'effects', ownerId: 'synthetic-owner', provider: 'codex', name: 'fixture', enabled: true, sortOrder: 0, config: { accounts: [{ chatgptAccountId: account.chatgptAccountId, email: 'synthetic@example.invalid', chatgptUserId: 'synthetic-user', planType: 'pro' }] }, state: { accounts: [account] }, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: now, updatedAt: now })
  const returned = await ensureCodexAccessToken('effects', account.chatgptAccountId, async () => {
    await sibling.upstreams.saveState('effects', current => ({ ...current, accounts: [{ ...account, refresh_token: 'synthetic-replacement-refresh', accessToken: access('synthetic-replacement-access') }] }))
    return access('synthetic-stale-mint-access')
  })
  const stored = (await repo.upstreams.getById('effects')).state.accounts[0]
  const reproduced = returned.token === 'synthetic-stale-mint-access' && stored.refresh_token === 'synthetic-replacement-refresh' && stored.accessToken.token === 'synthetic-stale-mint-access'
  return Response.json({ passed: reproduced, baselineRevision: '434f97e85c57cea16075cefd97c2bd3061f5d3f3', defectReproduced: reproduced, staleMintReturned: returned.token === 'synthetic-stale-mint-access', replacementAccessOverwritten: stored.accessToken.token !== 'synthetic-replacement-access', refreshAndAccessFromDifferentAttempts: reproduced })
} }
