/**
 * listProviderBindings must fail loud when the proxy catalog cannot be loaded.
 *
 * On a proxy-only host, silently falling back to each provider's direct
 * fetcher would send a whole batch of inference requests out over a direct
 * connection instead of erroring — so a storage failure while reading the
 * proxy rows has to propagate.
 *
 * Real BunSqliteRepo, with only `proxies.list` swapped for a throwing stub:
 * mock.module() is not used, it leaks across test files in Bun 1.3.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { __resetPlatformForTests, initRuntimeLocation } from '@vibe-core/platform'
import { initRepo, type UpstreamRecord } from '../src/repo/index.ts'
import type { UserId } from '../src/repo/branded-ids.ts'
import { listProviderBindings } from '../src/data-plane/providers/registry.ts'

const OWNER = 'u1' as UserId
const NOW = '2026-01-01T00:00:00.000Z'
const STORAGE_FAILURE = 'proxy catalog storage unavailable'

let repo: SqliteRepo

beforeEach(() => {
  __resetPlatformForTests()
  repo = new SqliteRepo(new Database(':memory:'))
  initRepo(repo)
  initRuntimeLocation('bun')
})

/**
 * The chain names a non-builtin proxy id on purpose: loadProxyCatalog returns
 * early without touching `proxies.list()` when nothing references a real proxy
 * row, and then there would be no storage read to fail.
 */
function brokenChainUpstream(): UpstreamRecord {
  return {
    id: 'ups-broken',
    ownerId: OWNER,
    provider: 'custom',
    name: 'broken',
    enabled: true,
    sortOrder: 0,
    config: {},
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
    proxyFallbackList: [{ id: 'px_a' }],
    createdAt: NOW,
    updatedAt: NOW,
  }
}

test('a proxy catalog read failure rejects instead of yielding direct-dialing bindings', async () => {
  // Saved through the real repo first, so the row is genuine SQLite state and
  // only the catalog read is broken.
  await repo.upstreams.save(brokenChainUpstream())

  initRepo({
    ...repo,
    proxies: {
      ...repo.proxies,
      list: async () => {
        throw new Error(STORAGE_FAILURE)
      },
    },
  })

  await expect(listProviderBindings({ ownerId: OWNER })).rejects.toThrow(STORAGE_FAILURE)
})

/**
 * The other two ways the fetcher build can fail. Both are startup-order bugs
 * rather than data problems, and both must reject for the same reason as the
 * catalog read above: a build that does not happen leaves every plugin without
 * `ctx.fetcherForUpstream`, i.e. direct egress on a proxy-only host.
 *
 * `beforeEach` initializes both singletons, so each case resets and re-inits
 * only the one it is not testing.
 */
test('an uninitialized runtime location rejects rather than yielding bindings', async () => {
  __resetPlatformForTests()
  initRepo(repo)
  // No initRuntimeLocation: `getRuntimeLocation()` throws while evaluating the
  // argument to createPerRequestFetcher, before the fetcher exists at all.
  await expect(listProviderBindings({ ownerId: OWNER })).rejects.toThrow(
    /Runtime location not initialized/,
  )
})

test('an uninitialized repo rejects rather than yielding bindings', async () => {
  __resetPlatformForTests()
  initRuntimeLocation('bun')
  // Reaching the throw at all is the point: `listVisibleUpstreams`'s own
  // `getRepo()` fails first and registry.ts swallows that into an empty list,
  // so this pins that the swallow stops there and does not cover the
  // `getRepo()` inside createPerRequestFetcher (per-request.ts:35).
  await expect(listProviderBindings({ ownerId: OWNER })).rejects.toThrow(
    /Repo not initialized/,
  )
})
