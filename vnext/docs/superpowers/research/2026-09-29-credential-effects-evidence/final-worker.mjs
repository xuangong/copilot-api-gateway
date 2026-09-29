import { D1Repo } from '__ROOT__/vnext/apps/platform-cloudflare/src/d1-repo.ts'
import { initUpstreamRepo } from '__ROOT__/vnext/packages/upstream-repo/src/index.ts'
import { ensureCodexAccessToken, invalidateCodexAccessToken, refreshCodexAccessTokenForRetry } from '__ROOT__/vnext/packages/provider-codex/src/access-token.ts'
import { codexBearerEffect, persistCodexTerminalState } from '__ROOT__/vnext/packages/provider-codex/src/credential-effects.ts'
import { putCodexQuota } from '__ROOT__/vnext/packages/provider-codex/src/quota.ts'
import { CodexOAuthSessionTerminatedError } from '__ROOT__/vnext/packages/provider-codex/src/auth/oauth.ts'
import { callCodexResponses, callCodexResponsesCompact, callCodexAlphaSearch } from '__ROOT__/vnext/packages/provider-codex/src/fetch.ts'
import { codexProviderPlugin } from '__ROOT__/vnext/packages/provider-codex/src/plugin.ts'
import { codexRawToProviderModel } from '__ROOT__/vnext/packages/provider-codex/src/models.ts'
import { initBackground } from '__ROOT__/vnext/packages/platform/src/index.ts'
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const errorName = async promise => { try { await promise; return 'NO_ERROR' } catch (error) { return error.name } }
export default { async fetch(_request, env) { try {
  const repo = new D1Repo(env.DB), sibling = new D1Repo(env.DB), results = {}
  initUpstreamRepo(() => repo.upstreams)
  const now = new Date().toISOString(), future = Date.now() + 3600_000, accountId = 'synthetic-account'
  const access = token => ({ token, expiresAt: future, refreshedAt: now })
  const account = (revision = 'original', token = 'original-access') => ({ chatgptAccountId: accountId, credentialRevision: revision, refresh_token: `${revision}-refresh`, state: 'active', state_updated_at: now, openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: token === null ? null : access(token), quotaSnapshot: null })
  const row = (id, credential = account()) => ({ id, ownerId: 'synthetic-owner', provider: 'codex', name: 'fixture', enabled: true, sortOrder: 0, config: { accounts: [{ chatgptAccountId: accountId, email: 'synthetic@example.invalid', chatgptUserId: 'synthetic-user', planType: 'pro' }] }, state: { accounts: [credential] }, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: now, updatedAt: now })
  const state = async id => (await repo.upstreams.getById(id)).state.accounts[0]
  const replace = (id, revision = 'replacement', token = 'replacement-access') => sibling.upstreams.saveState(id, current => ({ ...current, accounts: [account(revision, token)] }))
  const neverMint = async () => { throw new Error('Unexpected OAuth mint') }
  const quota = { observed_at: now, active_limit: 'fixture', primary_used_percent: 37 }

  await repo.upstreams.save(row('atomic'))
  const initial = await ensureCodexAccessToken('atomic', accountId, neverMint)
  await env.DB.prepare('CREATE TABLE effect_audit(refresh TEXT, access TEXT)').run()
  await env.DB.prepare("CREATE TRIGGER audit_effect_state AFTER UPDATE OF state_json ON upstreams WHEN NEW.id='atomic' BEGIN INSERT INTO effect_audit VALUES(json_extract(NEW.state_json,'$.accounts[0].refresh_token'),json_extract(NEW.state_json,'$.accounts[0].accessToken.token')); END").run()
  const atomic = await ensureCodexAccessToken('atomic', accountId, async refresh => {
    assert(refresh === 'original-refresh', 'Wrong refresh input')
    await putCodexQuota(initial, quota)
    return { refreshToken: 'rotated-refresh', accessToken: access('rotated-access') }
  }, true)
  const writes = (await env.DB.prepare('SELECT refresh,access FROM effect_audit').all()).results
  assert(writes.length === 2, 'Quota and token pair must be two total state updates')
  assert(writes.every(entry => (entry.refresh === 'original-refresh' && entry.access === 'original-access') || (entry.refresh === 'rotated-refresh' && entry.access === 'rotated-access')), 'Partial token pair visible')
  const afterAtomic = await state('atomic')
  assert(atomic.token === 'rotated-access' && afterAtomic.refresh_token === 'rotated-refresh', 'Rotation not committed')
  assert(afterAtomic.quotaSnapshot.fixture.data.primary_used_percent === 37, 'Concurrent quota lost')
  results.atomicRotationAndQuota = { stateWrites: writes.length, partialPairs: 0 }

  await repo.upstreams.save(row('late-success', account('original', null)))
  const recovered = await ensureCodexAccessToken('late-success', accountId, async () => {
    await replace('late-success')
    return { refreshToken: 'late-refresh', accessToken: access('late-access') }
  })
  assert(recovered.token === 'replacement-access' && recovered.credential.credentialRevision === 'replacement', 'Losing mint returned stale credentials')
  assert((await state('late-success')).refresh_token === 'replacement-refresh', 'Losing mint replaced refresh token')
  results.lateSuccessUsesAuthoritativeCredential = true

  for (const code of ['invalid_grant', 'invalid_refresh_token', 'app_session_terminated']) {
    const id = `late-failure-${code}`
    await repo.upstreams.save(row(id, account('original', null)))
    const lease = await ensureCodexAccessToken(id, accountId, async () => {
      await replace(id)
      throw new CodexOAuthSessionTerminatedError({ code, message: 'synthetic terminal' })
    })
    assert(lease.token === 'replacement-access' && (await state(id)).state === 'active', 'Old OAuth error damaged replacement')
  }
  results.lateTerminalOAuthFailures = 3

  await repo.upstreams.save(row('late-effects'))
  const stale = await ensureCodexAccessToken('late-effects', accountId, neverMint)
  await replace('late-effects')
  await invalidateCodexAccessToken(stale)
  await persistCodexTerminalState(codexBearerEffect(stale), 'session_terminated', 'synthetic terminal')
  await putCodexQuota(stale, quota)
  const afterEffects = await state('late-effects')
  assert(afterEffects.state === 'active' && afterEffects.accessToken.token === 'replacement-access' && afterEffects.quotaSnapshot === null, 'Late bearer effects damaged replacement')
  let minted = 0
  const retry = await refreshCodexAccessTokenForRetry(stale, async () => { minted++; return { refreshToken: 'wrong-refresh', accessToken: access('wrong-access') } })
  assert(retry.token === 'replacement-access' && minted === 0, 'Late 401 did not reuse authoritative bearer')
  results.staleBearerTerminalQuotaAnd401 = true

  await repo.upstreams.save(row('latest-refresh'))
  const old = await ensureCodexAccessToken('latest-refresh', accountId, neverMint)
  await replace('latest-refresh', 'replacement', null)
  const next = await refreshCodexAccessTokenForRetry(old, async used => {
    assert(used === 'replacement-refresh', '401 used captured old refresh token')
    return { refreshToken: 'newest-refresh', accessToken: access('newest-access') }
  })
  assert(next.token === 'newest-access' && next.credential.credentialRevision === 'replacement', '401 lost new revision')
  results.retryUsesLatestRefresh = true

  await repo.upstreams.save(row('aba-success', account('original', null)))
  const abaName = await errorName(ensureCodexAccessToken('aba-success', accountId, async () => {
    await sibling.upstreams.delete('aba-success')
    await sibling.upstreams.save(row('aba-success', account('original', null)))
    return { refreshToken: 'late-refresh', accessToken: access('late-access') }
  }))
  assert(abaName === 'UpstreamReplacedError', `ABA success not rejected: ${abaName}`)
  assert((await state('aba-success')).accessToken === null, 'ABA success mutated replacement')
  results.deleteRecreateMint = abaName
  await repo.upstreams.save(row('aba-effects'))
  const abaLease = await ensureCodexAccessToken('aba-effects', accountId, neverMint)
  await sibling.upstreams.delete('aba-effects'); await sibling.upstreams.save(row('aba-effects'))
  await invalidateCodexAccessToken(abaLease)
  await persistCodexTerminalState(codexBearerEffect(abaLease), 'session_terminated', 'synthetic terminal')
  await putCodexQuota(abaLease, quota)
  const abaState = await state('aba-effects')
  assert(abaState.state === 'active' && abaState.accessToken.token === 'original-access' && abaState.quotaSnapshot === null, 'ABA effects mutated replacement')
  results.deleteRecreateEffects = true

  const background = []
  initBackground({ waitUntil: promise => { background.push(promise) } })
  const stableHeaders = ['session_id', 'x-client-request-id', 'x-codex-turn-metadata', 'x-codex-session-id', 'x-codex-thread-id']
  for (const [kind, call] of [['responses', callCodexResponses], ['compact', callCodexResponsesCompact], ['alpha', callCodexAlphaSearch]]) {
    const id = `request-${kind}`
    await repo.upstreams.save(row(id))
    const firstLease = await ensureCodexAccessToken(id, accountId, neverMint), calls = []
    let oauth = 0
    const response = await call({
      upstreamId: id, account: await state(id), credential: firstLease.credential,
      model: { id: 'gpt-5' }, headers: new Headers(),
      body: kind === 'alpha' ? { commands: { search_query: [{ query: 'synthetic' }] } } : { input: [{ type: 'message', role: 'user', content: 'synthetic' }] },
      fetcher: async (_url, init) => {
        oauth++
        assert(new URLSearchParams(String(init.body)).get('refresh_token') === 'replacement-refresh', 'HTTP retry minted using stale refresh')
        return Response.json({ access_token: 'http-new-access', refresh_token: 'http-new-refresh', id_token: 'synthetic-id-token', expires_in: 3600 })
      },
      executionFetcher: async (_url, init) => {
        const headers = new Headers(init.headers)
        calls.push({ body: init.body, bearer: headers.get('authorization'), identity: stableHeaders.map(key => headers.get(key)) })
        if (calls.length === 1) {
          await replace(id, 'replacement', kind === 'compact' ? null : 'replacement-access')
          return Response.json({ error: { message: 'synthetic unauthorized' } }, { status: 401 })
        }
        return kind === 'responses'
          ? new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"synthetic","status":"completed","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
          : Response.json({ id: 'synthetic', output: [] })
      },
    })
    assert(response.status === 200, `${kind} auth retry failed`); await response.text()
    await Promise.all(background.splice(0))
    assert(calls.length === 2 && calls[0].body === calls[1].body, `${kind} prepared body changed`)
    assert(JSON.stringify(calls[0].identity) === JSON.stringify(calls[1].identity), `${kind} request identity changed`)
    assert(calls[0].bearer === 'Bearer original-access' && calls[1].bearer === `Bearer ${kind === 'compact' ? 'http-new-access' : 'replacement-access'}`, `${kind} wrong bearer selection`)
    assert(oauth === (kind === 'compact' ? 1 : 0), `${kind} unexpected OAuth retry count`)
    results[`http-${kind}`] = { attempts: calls.length, oauth, bodyStable: true, identityStable: true }
  }
  const initialTargetResults = []
  for (const mutation of ['owner', 'recreate', 'provider']) {
    for (const entrypoint of ['catalog', 'responses', 'compact', 'alpha_search']) {
      const id = `initial-${mutation}-${entrypoint}`
      await repo.upstreams.save(row(id))
      const authorizedRow = await repo.upstreams.getById(id)
      let sends = 0
      const provider = await codexProviderPlugin.createFromUpstream(authorizedRow, {
        fetcherForUpstream: () => async () => {
          sends++
          if (entrypoint === 'catalog') return Response.json({ models: [{ slug: 'gpt-5', display_name: 'Synthetic', context_window: 128000 }] })
          return Response.json({ id: 'synthetic', output: [] })
        },
      })
      if (entrypoint !== 'catalog') provider.setModelCatalog({ object: 'list', data: [codexRawToProviderModel({ id: 'gpt-5', display_name: 'Synthetic', context_window: 128000 })] })
      if (mutation === 'recreate') await sibling.upstreams.delete(id)
      await sibling.upstreams.save({ ...row(id, account('replacement', 'replacement-access')), ownerId: 'replacement-owner', provider: mutation === 'provider' ? 'custom' : 'codex' })
      const outcome = await errorName(entrypoint === 'catalog' ? provider.getModels() : provider.fetch({
        endpoint: entrypoint === 'alpha_search' ? 'alpha_search' : 'responses',
        action: entrypoint === 'compact' ? 'compact' : 'generate', sourceApi: 'responses',
        headers: new Headers(), signal: new AbortController().signal,
        payload: { model: 'gpt-5', input: [] },
      }))
      assert(outcome === 'UpstreamReplacedError' && sends === 0, `Initial target fence ${mutation}/${entrypoint}: ${outcome}, sends=${sends}`)
      initialTargetResults.push({ mutation, entrypoint, error: outcome, sends })
    }
  }
  results.initialAuthorizedTargets = initialTargetResults
  return Response.json({ passed: true, results })
} catch (error) { return Response.json({ passed: false, error: { name: error.name, message: error.message, stack: error.stack } }, { status: 500 }) } } }
