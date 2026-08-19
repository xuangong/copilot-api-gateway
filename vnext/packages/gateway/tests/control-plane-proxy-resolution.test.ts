/**
 * resolveControlPlaneFetcher — one case per branch plus both error shapes.
 *
 * Backed by a real BunSqliteRepo: the override branch reads the `proxies`
 * table through loadProxyCatalog, and a hand-written fake would prove nothing
 * about the real JSON/column plumbing. mock.module() is not used — it leaks
 * across test files in Bun 1.3.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo, type UpstreamRecord } from '../src/repo/index.ts'
import { resolveControlPlaneFetcher } from '../src/control-plane/upstreams/proxy-resolution.ts'

const LOC = 'test-colo'
const NOW = '2026-01-01T00:00:00.000Z'
const TROJAN_URL = 'trojan://pw@node.example.com:443'

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  initRepo(repo)
})

function upstreamRow(over: Partial<UpstreamRecord> = {}): UpstreamRecord {
  return {
    id: 'up_test',
    provider: 'custom',
    name: 'test',
    enabled: true,
    sortOrder: 0,
    config: {},
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
    proxyFallbackList: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

/**
 * Chain-specific probe. A fetcher built over a materialized transport (proxy
 * or direct_connect) refuses a ReadableStream body, because the two-pass dial
 * can replay a request and a stream is single-shot. `directFetcher` and any
 * plain stub would happily accept one, so this distinguishes a real
 * chain-backed fetcher from "some function". Fully offline — the rejection
 * happens before any dial.
 */
async function expectChainBackedFetcher(fetcher: unknown): Promise<void> {
  expect(typeof fetcher).toBe('function')
  const call = (fetcher as (url: string, init: RequestInit) => Promise<Response>)(
    'https://example.com',
    { method: 'POST', body: new ReadableStream() },
  )
  await expect(call).rejects.toThrow(
    'streaming request bodies are not replayable through direct-connect or proxy transports',
  )
}

test('no override and no upstreamId leaves the caller on global fetch', async () => {
  const fetcher = await resolveControlPlaneFetcher({ runtimeLocation: LOC })
  expect(fetcher).toBeUndefined()
})

test('an empty override leaves the caller on global fetch', async () => {
  const fetcher = await resolveControlPlaneFetcher({ override: [], runtimeLocation: LOC })
  expect(fetcher).toBeUndefined()
})

test('override referencing a known proxy resolves', async () => {
  await repo.proxies.save({
    id: 'px_known',
    name: 'known',
    url: TROJAN_URL,
    dialTimeoutSeconds: null,
  })
  const fetcher = await resolveControlPlaneFetcher({
    override: [{ id: 'px_known' }],
    runtimeLocation: LOC,
  })
  await expectChainBackedFetcher(fetcher)
})

// A direct-only chain never touches the proxy catalog — loadProxyCatalog early
// -returns on an empty referenced set. Pins the isDirectFallbackId guards: a
// regression in either would surface here as "unknown proxy id".
test('a direct-only override resolves without consulting the proxy catalog', async () => {
  const fetcher = await resolveControlPlaneFetcher({
    override: [{ id: 'direct_connect' }],
    runtimeLocation: LOC,
  })
  await expectChainBackedFetcher(fetcher)
})

test('override referencing an unknown proxy throws naming the id', async () => {
  await expect(
    resolveControlPlaneFetcher({ override: [{ id: 'px_missing' }], runtimeLocation: LOC }),
  ).rejects.toThrow('unknown proxy id in fallback list: px_missing')
})

test('override referencing a malformed proxy throws naming the id, not the url', async () => {
  await repo.proxies.save({
    id: 'px_bad',
    name: 'bad',
    url: 'not-a-proxy-uri',
    dialTimeoutSeconds: null,
  })
  const err = await resolveControlPlaneFetcher({
    override: [{ id: 'px_bad' }],
    runtimeLocation: LOC,
  }).then(
    () => null,
    (e: Error) => e,
  )
  expect(err).not.toBeNull()
  expect(err!.message).toContain('malformed proxy px_bad')
  expect(err!.message).not.toContain('not-a-proxy-uri')
})

test('an upstream with a chain resolves to the per-request fetcher', async () => {
  await repo.proxies.save({
    id: 'px_up',
    name: 'up',
    url: TROJAN_URL,
    dialTimeoutSeconds: null,
  })
  await repo.upstreams.save(
    upstreamRow({ id: 'up_proxied', proxyFallbackList: [{ id: 'px_up' }] }),
  )
  const fetcher = await resolveControlPlaneFetcher({
    upstreamId: 'up_proxied',
    runtimeLocation: LOC,
  })
  await expectChainBackedFetcher(fetcher)
})

// The row is handed straight to createPerRequestFetcher, so a disabled
// upstream resolves like any other. Letting that factory load its own list
// would filter `enabled = 1` and make this throw — reachable from the normal
// admin loop of disable → fix → Test before re-enabling.
test('a disabled upstream with a chain still resolves', async () => {
  await repo.proxies.save({
    id: 'px_off',
    name: 'off',
    url: TROJAN_URL,
    dialTimeoutSeconds: null,
  })
  await repo.upstreams.save(
    upstreamRow({ id: 'up_off', enabled: false, proxyFallbackList: [{ id: 'px_off' }] }),
  )
  const fetcher = await resolveControlPlaneFetcher({
    upstreamId: 'up_off',
    runtimeLocation: LOC,
  })
  await expectChainBackedFetcher(fetcher)
})

test('an upstream with no chain leaves the caller on global fetch', async () => {
  await repo.upstreams.save(upstreamRow({ id: 'up_direct', proxyFallbackList: [] }))
  const fetcher = await resolveControlPlaneFetcher({
    upstreamId: 'up_direct',
    runtimeLocation: LOC,
  })
  expect(fetcher).toBeUndefined()
})

// A row that does not exist has no chain, so it means "direct" — same as a row
// with an empty chain. Callers that derive an id (quota, the account list) hit
// this whenever an account predates upstream mirroring; making it throw would
// turn a legacy account into a 502 with no configuration error behind it.
test('upstreamId branch returns undefined for an unknown upstream', async () => {
  const fetcher = await resolveControlPlaneFetcher({
    upstreamId: 'up_nope',
    runtimeLocation: LOC,
  })
  expect(fetcher).toBeUndefined()
})
