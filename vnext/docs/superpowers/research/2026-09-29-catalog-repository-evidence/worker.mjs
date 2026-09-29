import { D1Repo } from '__ROOT__/vnext/apps/platform-cloudflare/src/d1-repo.ts'
const assert = (value, message) => { if (!value) throw new Error(message) }
const present = value => { assert(value !== null && value !== undefined, 'Missing fixture result'); return value }
const rejects = async (promise, name) => {
  try { await promise } catch (error) { assert(error.name === name, `Expected ${name}, got ${error.name}`); return }
  throw new Error(`Expected ${name}, got success`)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export default { async fetch(_request, env) { try {
  const first = new D1Repo(env.DB), second = new D1Repo(env.DB), results = {}
  const models = { object: 'list', data: [{ id: 'synthetic-model', capability: { enabled: true } }] }
  const row = id => ({ id, ownerId: 'synthetic-owner', provider: 'custom', name: 'Fixture', enabled: true, sortOrder: 0,
    config: { baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-key' }, state: { access: 'synthetic-access', quota: 1 },
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: 'same', updatedAt: 'same' })
  const read = async (id, revision = 5) => present(await first.catalogs.read(id, revision))
  const acquire = async (identity, options) => present(await first.catalogs.tryAcquire(identity, options))

  await first.upstreams.save(row('compete'))
  const observed = await read('compete')
  const leases = await Promise.all([first.catalogs.tryAcquire(observed.identity), second.catalogs.tryAcquire(observed.identity)])
  assert(leases.filter(Boolean).length === 1, 'Two concurrent D1 lease winners')
  const lease = present(leases.find(Boolean))
  const published = present(await first.catalogs.publish(lease, models))
  const current = await read('compete')
  assert(eq(current.snapshot, published) && current.lease === null && eq(published.models, models), 'Publication not persisted atomically')
  results.concurrentLeaseAndAtomicPublication = true

  const secondPublication = present(await first.catalogs.publish(await acquire(current.identity,{explicit:true}),models))
  assert(secondPublication.publicationVersion > published.publicationVersion, 'Publication ordering depends only on second-resolution timestamp')
  results.monotonicPublicationVersion = true

  await first.upstreams.save({ ...row('ownerless'), ownerId: undefined })
  const ownerless = await read('ownerless')
  assert(ownerless.identity.ownerId === undefined, 'Ownerless identity fabricated')
  assert(await first.catalogs.publish(await acquire(ownerless.identity),models) !== null, 'Ownerless publication rejected')
  await first.upstreams.replaceCredentials(ownerless.upstream,{config:ownerless.upstream.config,state:{reimport:true}})
  assert((await read('ownerless')).upstream.catalogGeneration === 1, 'Ownerless credential replacement failed')
  results.ownerlessPublicationAndReplacement = true

  const oldLease = await acquire(current.identity, { explicit: true })
  await env.DB.prepare("UPDATE model_catalogs SET lease_until_ms=1 WHERE upstream_id='compete'").run()
  const winnerLease = present(await second.catalogs.tryAcquire(current.identity))
  const newer = { object: 'list', data: [{ id: 'newer' }] }
  const winningSnapshot = present(await second.catalogs.publish(winnerLease, newer))
  assert(await first.catalogs.publish(oldLease, models) === null, 'Stale success accepted')
  assert(await first.catalogs.recordFailure(oldLease, 'timeout') === null, 'Stale failure accepted')
  assert(eq((await read('compete')).snapshot, winningSnapshot), 'Stale result changed winner')
  results.takeoverRejectsLateSuccessAndFailure = true

  const failureLease = await acquire(current.identity, { explicit: true })
  const failure = present(await first.catalogs.recordFailure(failureLease, 'timeout'))
  const restarted = new D1Repo(env.DB)
  const retryState = present(await restarted.catalogs.read('compete', 5))
  assert(failure.failureCount === 1 && retryState.retryAtMs > retryState.databaseNowMs, 'Failure backoff not persisted')
  assert(eq(retryState.snapshot.models, newer), 'Failure lost last successful models')
  assert(await restarted.catalogs.tryAcquire(current.identity) === null, 'Automatic retry bypassed backoff')
  const explicit = present(await restarted.catalogs.tryAcquire(current.identity, { explicit: true }))
  assert(await first.catalogs.tryAcquire(current.identity, { explicit: true }) === null, 'Explicit retry bypassed live lease')
  await restarted.catalogs.publish(explicit, newer)
  results.persistentBackoffAndExplicitJoin = true

  await first.upstreams.save(row('generation'))
  const before = await read('generation')
  const display = await first.upstreams.patchMetadata(before.upstream, value => ({ ...value, name: 'Renamed', sortOrder: 9, disabledPublicModelIds: ['excluded'], flagOverrides: { synthetic: true } }))
  await second.upstreams.saveState('generation', () => ({ access: 'rotated', refresh: 'rotated', quota: 2 }))
  assert(display.catalogGeneration === 0 && eq((await read('generation')).identity, before.identity), 'Display/rotation advanced discovery identity')
  const configured = await first.upstreams.patchMetadata(display, value => ({ ...value, config: { ...value.config, baseUrl: 'https://changed.invalid' } }))
  assert(configured.catalogGeneration === 1, 'RETURNING exposed pre-trigger generation')
  assert((await read('generation')).identity.configurationFingerprint !== before.identity.configurationFingerprint, 'Configuration fingerprint did not change')
  results.generationProjectionAndReturnedMetadata = true

  for (const [column, value] of [['owner_id','new-owner'],['provider','azure'],['config_json','{}'],['enabled',0],['proxy_fallback_list_json','[{"id":"direct_fetch"}]']]) {
    const id = `change-${column}`
    await first.upstreams.save(row(id))
    const original = await read(id), active = await acquire(original.identity)
    await env.DB.prepare(`UPDATE upstreams SET ${column}=? WHERE id=?`).bind(value,id).run()
    assert(await first.catalogs.publish(active, models) === null, `${column} accepted old publish`)
    assert(await first.catalogs.recordFailure(active, 'upstream_error') === null, `${column} accepted old failure`)
    assert(await first.catalogs.tryAcquire(original.identity, { explicit: true }) === null, `${column} accepted old acquisition`)
    const next = await read(id)
    assert(next.upstream.catalogGeneration === 1 && next.snapshot === null, `${column} retained stale identity snapshot`)
  }
  results.discoveryFieldFences = 5

  await first.upstreams.save({ ...row('proxy'), proxyFallbackList: [{ id: 'route' }] })
  await first.upstreams.save(row('unrelated'))
  const proxyBefore = await read('proxy')
  await first.proxies.save({ id: 'route', name: 'Synthetic route', url: 'http://synthetic:secret@localhost:1', dialTimeoutSeconds: 2 })
  const proxyAfter = await read('proxy')
  assert(proxyAfter.upstream.catalogGeneration === 1 && proxyAfter.identity.configurationFingerprint !== proxyBefore.identity.configurationFingerprint, 'Proxy creation ignored')
  await second.proxies.patch('route', { name: 'Display only' })
  assert(eq((await read('proxy')).identity, proxyAfter.identity), 'Proxy display changed identity')
  const proxyLease = await acquire(proxyAfter.identity)
  await second.proxies.patch('route', { dialTimeoutSeconds: 4 })
  assert(await first.catalogs.publish(proxyLease, models) === null, 'Proxy route change accepted old publish')
  await second.proxies.patch('route', { url: 'http://localhost:2' })
  await env.DB.prepare("DELETE FROM proxies WHERE id='route'").run()
  assert((await read('proxy')).upstream.catalogGeneration === 4, 'Dependent proxy generation not exact')
  assert((await read('unrelated')).upstream.catalogGeneration === 0, 'Unrelated proxy dependency changed')
  results.proxyDependencyFences = true

  await first.upstreams.save({ ...row('read-race'), proxyFallbackList:[{id:'read-route'}] })
  await first.proxies.save({id:'read-route',name:'Fixture',url:'http://localhost:1',dialTimeoutSeconds:2})
  let proxyReads = 0, continuous = false
  const wrap = (statement,sql) => ({
    bind: (...values) => wrap(statement.bind(...values),sql),
    first: (...args) => statement.first(...args),
    run: (...args) => statement.run(...args),
    all: async (...args) => {
      const actual = await statement.all(...args)
      if (sql.includes('FROM proxies')) {
        proxyReads++
        if (continuous || proxyReads === 1) await second.proxies.patch('read-route',{url:`http://localhost:${10+proxyReads}`})
      }
      return actual
    },
  })
  const racing = new D1Repo({prepare:sql=>wrap(env.DB.prepare(sql),sql),batch:statements=>env.DB.batch(statements)})
  const consistent = present(await racing.catalogs.read('read-race',5))
  assert(proxyReads === 2 && consistent.proxies[0].url === 'http://localhost:11', 'Read did not rebase changed dependent proxy')
  continuous = true
  await rejects(racing.catalogs.read('read-race',5),'UpstreamContentionError')
  assert(proxyReads === 6, 'Read contention was not bounded')
  results.authoritativeDependencyReadRebaseAndBound = true

  await first.upstreams.save(row('aba'))
  const abaBefore = await read('aba'), abaLease = await acquire(abaBefore.identity)
  await second.upstreams.delete('aba')
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM model_catalogs WHERE upstream_id='aba'").first()
  assert(count.n === 0, 'Delete cleanup relied on disabled foreign_keys')
  await second.upstreams.save(row('aba'))
  const abaAfter = await read('aba')
  assert(abaAfter.upstream.rowIncarnation !== abaBefore.upstream.rowIncarnation, 'Recreation did not change incarnation')
  assert(await first.catalogs.publish(abaLease, models) === null && await first.catalogs.tryAcquire(abaBefore.identity) === null, 'ABA accepted old identity')
  results.exactTimestampRecreationAndCleanup = true

  await first.upstreams.save(row('import'))
  const importBefore = await read('import'), importLease = await acquire(importBefore.identity)
  const importAfter = await first.upstreams.replaceCredentials(importBefore.upstream, { config: { ...importBefore.upstream.config, account: 'same-account' }, state: { credentialRevision: 'new-revision', access: 'new-access' } })
  assert(importAfter.catalogGeneration === 1 && (await read('import')).upstream.catalogGeneration === 1, 'Credential replacement must advance generation once')
  assert(await first.catalogs.publish(importLease, models) === null, 'Import accepted old catalog')
  await rejects(first.upstreams.replaceCredentials(importBefore.upstream, { config: {}, state: {} }), 'UpstreamContentionError')
  const quotaTarget = (await read('import')).upstream
  await second.upstreams.saveState('import', state => ({ ...state, quota: 7 }))
  await rejects(first.upstreams.replaceCredentials(quotaTarget, { config: {}, state: {} }), 'UpstreamContentionError')
  assert((await read('import')).upstream.catalogGeneration === 1, 'Ordinary state changed import generation')
  results.versionedCredentialReplacement = true

  await first.upstreams.save(row('clock'))
  const clockView = await read('clock'), realNow = Date.now
  try {
    Date.now = () => 0
    const clockLease = await acquire(clockView.identity)
    assert(clockLease.leaseUntilMs > clockView.databaseNowMs, 'Application clock controlled database lease')
    await env.DB.prepare("UPDATE model_catalogs SET lease_until_ms=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE upstream_id='clock'").run()
    assert(await first.catalogs.publish(clockLease, models) === null && await first.catalogs.recordFailure(clockLease,'timeout') === null, 'Expired database lease accepted')
  } finally { Date.now = realNow }
  results.databaseClockExpiry = true

  await first.upstreams.save(row('versions'))
  for (const revision of [4,5]) {
    const versioned = await read('versions',revision)
    await first.catalogs.publish(await acquire(versioned.identity), { object:'list', data:[{id:`revision-${revision}`}] })
  }
  assert((await read('versions',4)).snapshot.models.data[0].id === 'revision-4' && (await read('versions',5)).snapshot.models.data[0].id === 'revision-5', 'Code revisions overwrote each other')
  results.codeRevisionCoexistence = true

  const activeOld = await acquire((await read('versions',3)).identity)
  await env.DB.prepare("UPDATE model_catalogs SET last_used_at_ms=1 WHERE upstream_id='versions'").run()
  const cutoff = (await read('compete')).databaseNowMs
  const removed = await first.catalogs.deleteInactiveRevisions({ activeRevisions:[5], inactiveBeforeMs:cutoff, limit:1 })
  assert(removed === 1, 'Inactive revision deletion did not honor one-row bound')
  const revisions = (await env.DB.prepare("SELECT catalog_revision FROM model_catalogs WHERE upstream_id='versions' ORDER BY catalog_revision").all()).results.map(value=>value.catalog_revision)
  assert(eq(revisions,[3,5]), 'Maintenance removed active revision or live lease')
  assert(await first.catalogs.publish(activeOld,models) !== null, 'Maintenance invalidated a live old-revision lease')
  results.boundedMaintenancePreservesActiveRevisionsAndLeases = true
  return Response.json({ passed: true, results })
} catch (error) { return Response.json({ passed:false,error:{name:error.name,message:error.message,stack:error.stack} },{status:500}) } } }
