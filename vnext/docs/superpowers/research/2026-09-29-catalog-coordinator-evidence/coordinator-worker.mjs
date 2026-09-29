import { D1Repo } from '__ROOT__/vnext/apps/platform-cloudflare/src/d1-repo.ts'
import { CatalogCoordinator } from '__ROOT__/vnext/packages/gateway/src/data-plane/providers/catalog-coordinator.ts'
import { sweepCatalogs } from '__ROOT__/vnext/packages/gateway/src/catalog-maintenance.ts'
const assert = (value, message) => { if (!value) throw new Error(message) }
const present = value => { assert(value !== null && value !== undefined, 'Missing fixture result'); return value }
const barrier = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const caught = promise => promise.then(value => ({ value }), error => ({ error }))
const models = id => ({ object: 'list', data: [{ id }] })
const row = id => ({ id, ownerId: 'synthetic-owner', provider: 'custom', name: 'Fixture', enabled: true, sortOrder: 0,
  config: { baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-key' }, state: {},
  flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: 'same', updatedAt: 'same' })
export default { async fetch(_request, env) { let stage = "start"; try {
  const first = new D1Repo(env.DB), second = new D1Repo(env.DB), results = {}, background = []
  const save = async id => { stage = id; await first.upstreams.save(row(id)); return present(await first.upstreams.getById(id)) }
  const request = (expected, mode = 'automatic', signal) => ({ expected, mode, signal, isVisible: value => value.enabled && value.ownerId === 'synthetic-owner' })
  const coordinator = (repo, discover, policy = {}, revision = 5) => new CatalogCoordinator({ catalogs: repo.catalogs, discover, background: work => { background.push(work) }, catalogRevision: revision, policy: { totalBudgetMs: 2000, pollMs: 10, ...policy } })

  {
    const expected = await save('one-fetch'), entered = barrier(), release = barrier(); let calls = 0
    const discover = async () => { calls++; entered.resolve(); await release.promise; return models('accepted') }
    const a = coordinator(first, discover), b = coordinator(second, discover)
    const winner = a.read(request(expected)); await entered.promise
    const loser = b.read(request(expected)); await delay(40); assert(calls === 1, 'Two D1 coordinator discovery winners')
    release.resolve(); const [one, two] = await Promise.all([winner, loser])
    assert(one.snapshot.publicationVersion === two.snapshot.publicationVersion && calls === 1, 'Cold loser missed accepted publication')
    results.independentCoordinatorsOneFetch = true
  }
  {
    const expected = await save('delayed-acquisition'), entered = barrier(), release = barrier(); let calls = 0
    const source = second.catalogs
    const catalogs = {
      read: (...args) => source.read(...args),
      tryAcquire: async (...args) => { entered.resolve(); await release.promise; return source.tryAcquire(...args) },
      publish: (...args) => source.publish(...args), recordFailure: (...args) => source.recordFailure(...args),
      deleteInactiveRevisions: (...args) => source.deleteInactiveRevisions(...args),
    }
    const b = new CatalogCoordinator({ catalogs, catalogRevision: 5, background: work => background.push(work),
      discover: async () => { calls++; throw new Error('Forbidden second discovery') }, policy: { totalBudgetMs: 2000, pollMs: 10 } })
    const delayed = caught(b.read(request(expected))); await entered.promise
    const accepted = await coordinator(first, async () => { calls++; return models('already-published') }).read(request(expected))
    release.resolve(); const result = await delayed
    assert(!result.error && calls === 1 && result.value.snapshot.publicationVersion === accepted.snapshot.publicationVersion,
      `Delayed acquisition ignored fresh publication: calls=${calls}, error=${result.error?.code}`)
    results.delayedAcquisitionReusesFreshPublication = true
  }
  {
    const expected = await save('loser-abort'), entered = barrier(), release = barrier(); let calls = 0, winnerSignal
    const discover = async (_observation, signal) => { calls++; winnerSignal = signal; entered.resolve(); await release.promise; return models('survives') }
    const a = coordinator(first, discover), b = coordinator(second, discover), abort = new AbortController()
    const winner = a.read(request(expected)); await entered.promise
    const loser = caught(b.read(request(expected, 'automatic', abort.signal))); await delay(30); abort.abort()
    assert((await loser).error && !winnerSignal.aborted, 'Loser abort canceled winner or was ignored')
    release.resolve(); assert((await winner).snapshot.models.data[0].id === 'survives' && calls === 1, 'Winner failed after independent loser abort')
    results.loserCancellationIsolated = true
  }
  {
    const expected = await save('late-timeout'), entered = barrier(), release = barrier(); let signal
    const a = coordinator(first, async (_observation, currentSignal) => { signal = currentSignal; entered.resolve(); await release.promise; return models('forbidden-late') }, { totalBudgetMs: 100 })
    const pending = caught(a.read(request(expected))); await entered.promise
    assert((await pending).error && signal.aborted, 'Deadline did not abort owned discovery')
    release.resolve(); await delay(40)
    assert((await first.catalogs.read(expected.id, 5)).snapshot === null, 'Abort-ignoring late discovery published')
    results.lateAbortIgnoringResultRejected = true
  }
  {
    const expected = await save('persistent-failure'); let calls = 0
    const discover = async () => { calls++; throw new Error('synthetic provider failure') }
    assert((await caught(coordinator(first, discover).read(request(expected)))).error, 'Cold discovery failure became success')
    assert((await caught(coordinator(second, discover).read(request(expected)))).error && calls === 1, 'Restart bypassed persistent retry backoff')
    const explicit = await coordinator(second, async () => { calls++; return models('recovered') }).read(request(expected, 'explicit'))
    assert(explicit.snapshot.models.data[0].id === 'recovered' && calls === 2, 'Explicit retry did not recover')
    results.persistentBackoffAndExplicitRecovery = true
  }
  {
    const expected = await save('changed-config'); let calls = 0
    const a = coordinator(first, async observation => {
      calls++
      if (calls === 1) await second.upstreams.patchMetadata(observation.upstream, value => ({ ...value, config: { ...value.config, baseUrl: 'https://changed.invalid' } }))
      return models(observation.upstream.config.baseUrl)
    })
    const accepted = await a.read(request(expected))
    assert(calls === 2 && accepted.snapshot.models.data[0].id === 'https://changed.invalid' && accepted.upstream.catalogGeneration === 1, 'Config edit during discovery accepted an old catalog')
    results.configChangeRebasedInsideBudget = true
  }
  {
    const expected = await save('old-owner'); await env.DB.prepare("UPDATE upstreams SET owner_id='other-owner' WHERE id=?").bind(expected.id).run(); let calls = 0
    const result = await caught(coordinator(first, async () => { calls++; return models('forbidden') }).read(request(expected)))
    assert(calls === 0 && (result.error || result.value === null), 'Old authorized request discovered under replacement owner')
    results.ownerReplacementRejectsOldTarget = true
  }
  {
    const expected = await save('proxy-source')
    const configured = await first.upstreams.patchMetadata(expected, value => ({ ...value, proxyFallbackList: [{ id: 'synthetic-proxy' }] }))
    await first.proxies.save({ id: 'synthetic-proxy', name: 'Fixture', url: 'http://localhost:1', dialTimeoutSeconds: 2 })
    await second.proxies.patch('synthetic-proxy', { url: 'http://localhost:2' })
    let seen
    const accepted = await coordinator(first, async observation => { seen = observation.proxies[0]?.url; return models('proxy-observed') }).read(request(configured))
    assert(seen === 'http://localhost:2' && accepted.proxies[0].url === seen, 'Discovery received stale proxy configuration')
    results.authoritativeProxyObservation = true
  }
  {
    const expected = await save('revision-coexistence')
    const one = await coordinator(first, async () => models('rev5'), {}, 5).read(request(expected))
    const two = await coordinator(second, async () => models('rev6'), {}, 6).read(request(expected))
    assert(one.snapshot.models.data[0].id === 'rev5' && two.snapshot.models.data[0].id === 'rev6', 'Code revision catalogs cross-contaminated')
    results.codeRevisionsCoexist = true
  }
  {
    const expected = await save('terminal-overwritten'), observed = present(await first.catalogs.read(expected.id, 5))
    const leaseA = present(await first.catalogs.tryAcquire(observed.identity)), entered = barrier(), release = barrier()
    let reads = 0, calls = 0
    const source = second.catalogs
    const catalogs = {
      read: async (...args) => { if (++reads === 2) { entered.resolve(); await release.promise } return source.read(...args) },
      tryAcquire: (...args) => source.tryAcquire(...args), publish: (...args) => source.publish(...args),
      recordFailure: (...args) => source.recordFailure(...args), deleteInactiveRevisions: (...args) => source.deleteInactiveRevisions(...args),
    }
    const a = new CatalogCoordinator({ catalogs, catalogRevision: 5, background: work => background.push(work), discover: async () => { calls++; return models('forbidden-duplicate') }, policy: { totalBudgetMs: 2000, pollMs: 10 } })
    const joined = caught(a.read(request(expected, 'explicit'))); await entered.promise
    await first.catalogs.recordFailure(leaseA, 'upstream_error')
    const leaseB = present(await first.catalogs.tryAcquire(observed.identity, { explicit: true }))
    await first.catalogs.publish(leaseB, models('success-b'))
    release.resolve(); const result = await joined
    assert(result.error?.code === 'superseded-unavailable' && calls === 0, 'Joined A misreported later B success')
    assert((await first.catalogs.read(expected.id, 5)).terminal.token === leaseB.token, 'Terminal outcome not tied to accepted lease')
    results.overwrittenJoinedOutcomeUnavailable = true
  }
  {
    const expected = await save('late-takeover'), entered = barrier(), release = barrier()
    const a = coordinator(first, async () => { entered.resolve(); await release.promise; return models('losing-a') })
    const pending = a.read(request(expected)); await entered.promise
    await env.DB.prepare("UPDATE model_catalogs SET lease_until_ms=1 WHERE upstream_id=?").bind(expected.id).run()
    const b = coordinator(second, async () => models('winning-b'))
    const winner = await b.read(request(expected)); release.resolve(); const loser = await pending
    assert(winner.snapshot.models.data[0].id === 'winning-b' && loser.snapshot.models.data[0].id === 'winning-b', 'Late A was returned or displaced accepted B')
    assert((await first.catalogs.read(expected.id, 5)).snapshot.publicationVersion === winner.snapshot.publicationVersion, 'Late A wrote another publication')
    results.takeoverRejectsLateDiscovery = true
  }
  {
    const expected = await save('stale-background'), view = present(await first.catalogs.read(expected.id, 5))
    await first.catalogs.publish(present(await first.catalogs.tryAcquire(view.identity)), models('stale'))
    await env.DB.prepare("UPDATE model_catalogs SET refreshed_at_ms=0, refresh_after_ms=0 WHERE upstream_id=?").bind(expected.id).run()
    const entered = barrier(), release = barrier()
    const a = coordinator(first, async () => { entered.resolve(); await release.promise; return models('refreshed') })
    const stale = await a.read(request(expected))
    assert(stale.snapshot.models.data[0].id === 'stale', 'Stale read waited for refresh')
    await entered.promise; release.resolve(); await Promise.all(background)
    assert((await a.read(request(expected))).snapshot.models.data[0].id === 'refreshed', 'Background result was not accepted')
    results.staleReturnsBeforeBackground = true
  }
  {
    const expected = await save('maintenance-policy')
    for (const revision of [3, 5, 6]) {
      const view = present(await first.catalogs.read(expected.id, revision))
      await first.catalogs.publish(present(await first.catalogs.tryAcquire(view.identity)), models(`revision-${revision}`))
    }
    await env.DB.prepare("UPDATE model_catalogs SET last_used_at_ms=0 WHERE upstream_id=?").bind(expected.id).run()
    await sweepCatalogs(first.catalogs, Date.now(), '[5]')
    const rows = await env.DB.prepare("SELECT catalog_revision FROM model_catalogs WHERE upstream_id=? ORDER BY catalog_revision").bind(expected.id).all()
    assert(JSON.stringify(rows.results.map(value => value.catalog_revision)) === '[5,6]', 'Maintenance removed active/future revision or retained obsolete revision')
    results.productionMaintenancePreservesActiveAndNewer = true
  }
  if (env.MEASURE_DEFAULT_BUDGET) {
    const expected = await save('production-default-budget'); let signal
    const a = new CatalogCoordinator({ catalogs: first.catalogs, catalogRevision: 5, background: work => background.push(work), discover: (_observation, currentSignal) => { signal = currentSignal; return new Promise(() => {}) } })
    const started = performance.now(), result = await caught(a.read(request(expected))), elapsedMs = performance.now() - started
    assert(result.error?.code === 'timeout' && signal.aborted && elapsedMs >= 19_500 && elapsedMs < 23_000, `Production default budget mismatch: ${elapsedMs}`)
    assert((await first.catalogs.read(expected.id, 5)).snapshot === null, 'Default timeout published models')
    results.measuredProductionDefaultBudget = { elapsedMs, aborted: signal.aborted }
  }
  await Promise.all(background)
  return Response.json({ passed: true, results })
} catch (error) { return Response.json({ passed: false, stage, name: error.name, message: error.message, stack: error.stack }, { status: 500 }) } } }
