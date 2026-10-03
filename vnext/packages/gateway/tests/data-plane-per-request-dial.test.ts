/**
 * createPerRequestFetcher — the malformed-proxy branch must name the offending
 * proxy id without echoing the proxy URI. The URI carries the proxy password in
 * its userinfo, and this error reaches 5xx response bodies and logs.
 *
 * Backed by a real BunSqliteRepo so the malformed row travels the actual
 * column/JSON plumbing into loadProxyCatalog. mock.module() is not used — it
 * leaks across test files in Bun 1.3.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo, type UpstreamRecord } from '../src/repo/index.ts'
import type { UserId } from '../src/repo/branded-ids.ts'
import { createPerRequestFetcher, preparePerRequestFetcher, createSingleUpstreamFetcher } from '../src/data-plane/dial/per-request.ts'
import type { ProxyRecord } from '@vibe-core/proxy-repo'
import type { DialObserver } from '@vibe-core/dial'
import { __resetPlatformForTests } from '@vibe-core/platform'

const LOC = 'test-colo'
const OWNER = 'u1' as UserId
const NOW = '2026-01-01T00:00:00.000Z'

/** Fake password, and a port outside 1..65535 so the URI fails to parse. */
const FAKE_PASSWORD = 'not-a-real-password-3f9c'
const MALFORMED_URL = `trojan://${FAKE_PASSWORD}@node.example.com:99999`

let repo: SqliteRepo
const restores: Array<() => void> = []

afterEach(() => {
  for (const restore of restores.splice(0)) restore()
})

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  initRepo(repo)
})

function upstreamRow(over: Partial<UpstreamRecord> = {}): UpstreamRecord {
  return {
    id: 'up_test',
    ownerId: OWNER,
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

test('a fetcher over a malformed proxy throws naming the id, not the url', async () => {
  await repo.proxies.save({
    id: 'px_bad',
    name: 'bad',
    url: MALFORMED_URL,
    dialTimeoutSeconds: null,
  })
  await repo.upstreams.save(
    upstreamRow({ id: 'up_bad', proxyFallbackList: [{ id: 'px_bad' }] }),
  )

  // The factory itself resolves: a bad row is isolated to the upstreams that
  // reference it, and only fails when that upstream is actually dialed.
  const fetcherFor = await createPerRequestFetcher(LOC)
  const err = await fetcherFor('up_bad')('https://example.com', {}).then(
    () => null,
    (e: Error) => e,
  )

  expect(err).not.toBeNull()
  expect(err!.message).toContain('malformed proxy px_bad')
  expect(err!.message).not.toContain(FAKE_PASSWORD)
  expect(err!.message).not.toContain('node.example.com')
})

test('explicit discovery proxy source overrides the pinned repository proxy', async () => {
  await repo.proxies.save({ id: 'px', name: 'valid', url: 'http://proxy.invalid:8080', dialTimeoutSeconds: null })
  const row = upstreamRow({ proxyFallbackList: [{ id: 'px' }] })
  const fetcher = await createPerRequestFetcher(LOC, [row], {
    proxies: { list: async () => [{ id: 'px', name: 'edited', url: MALFORMED_URL, dialTimeoutSeconds: null, createdAt: NOW, updatedAt: NOW }] },
    proxyBackoffs: repo.proxyBackoffs,
  })
  await expect(fetcher(row.id)('https://example.invalid', {})).rejects.toThrow('malformed proxy px')
})

function proxyRow(url = MALFORMED_URL): ProxyRecord {
  return { id: 'px', name: 'proxy', url, dialTimeoutSeconds: null, createdAt: NOW, updatedAt: NOW }
}

test('preparation reads once but consumes proxy URLs only when materialized', async () => {
  const row = upstreamRow({ proxyFallbackList: [{ id: 'px' }] })
  let reads = 0
  let urlReads = 0
  const captured = { ...proxyRow(), get url() { urlReads++; return MALFORMED_URL } }
  const source = { proxies: { list: async () => { reads++; return [captured] } }, proxyBackoffs: repo.proxyBackoffs }
  const fetcherFor = await preparePerRequestFetcher(LOC, [row], source)
  expect(reads).toBe(1)
  expect(urlReads).toBe(0)
  source.proxies.list = async () => { throw new Error('must not reread captured rows') }
  await expect(fetcherFor(row.id)('https://example.invalid', {})).rejects.toThrow('malformed proxy px')
  await expect(fetcherFor(row.id)('https://example.invalid', {})).rejects.toThrow('malformed proxy px')
  expect(reads).toBe(1)
  expect(urlReads).toBe(1)
})

test('existing eager API consumes referenced proxy URLs before returning its factory', async () => {
  let urlReads = 0
  const row = upstreamRow({ proxyFallbackList: [{ id: 'px' }] })
  const fetcherFor = await createPerRequestFetcher(LOC, [row], {
    proxies: { list: async () => [{ ...proxyRow(), get url() { urlReads++; return MALFORMED_URL } }] },
    proxyBackoffs: repo.proxyBackoffs,
  })
  expect(urlReads).toBe(1)
  await expect(fetcherFor(row.id)('https://example.invalid', {})).rejects.toThrow('malformed proxy px')
})

for (const mode of ['eager', 'lazy'] as const) {
  test(`${mode} factory keeps direct-only no-read and rejects unknown upstream ids`, async () => {
    const create = mode === 'eager' ? createPerRequestFetcher : preparePerRequestFetcher
    const row = upstreamRow({ proxyFallbackList: [{ id: 'direct_fetch' }] })
    const factory = await create(LOC, [row], {
      proxies: { list: async () => { throw new Error('direct-only proxy read') } },
      proxyBackoffs: repo.proxyBackoffs,
    })
    expect(() => factory('unknown')).toThrow('unknown upstream id')
    const originalFetch = globalThis.fetch
    const body = new FormData()
    body.set('field', 'native')
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBe(body)
      return new Response('native body')
    }) as typeof fetch
    restores.push(() => { globalThis.fetch = originalFetch })
    expect(await (await factory(row.id)('https://example.invalid', { method: 'POST', body })).text()).toBe('native body')
  })
}

test('lazy preflight still rejects repository failures before any factory invocation', async () => {
  await expect(preparePerRequestFetcher(LOC, [upstreamRow({ proxyFallbackList: [{ id: 'px', colos: ['elsewhere'] }] })], {
    proxies: { list: async () => { throw new Error('eager read failure') } }, proxyBackoffs: repo.proxyBackoffs,
  })).rejects.toThrow('eager read failure')
})

test('single authoritative factory ignores pinned rows and redacts malformed proxy details', async () => {
  await repo.proxies.save({ id: 'px', name: 'pinned', url: 'http://valid.invalid:8080', dialTimeoutSeconds: null })
  const row = upstreamRow({ proxyFallbackList: [{ id: 'px', colos: ['elsewhere'] }] })
  const factory = createSingleUpstreamFetcher(LOC, row, [proxyRow()], repo.proxyBackoffs)
  expect(() => factory('unknown')).toThrow('unknown upstream id')
  const error = await factory(row.id)('https://example.invalid', {}).catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error('missing dial failure')
  expect(error.message).toContain('malformed proxy px')
  expect(error.message).not.toContain(FAKE_PASSWORD)
  expect(error.message).not.toContain('node.example.com')
})

test('single authoritative factory retains its backoff owner and independent observers', async () => {
  const calls: string[] = []
  const owners: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('ok')) as typeof fetch
  restores.push(() => { globalThis.fetch = originalFetch })
  const row = upstreamRow({ proxyFallbackList: [{ id: 'missing' }, { id: 'direct_fetch' }] })
  const factory = createSingleUpstreamFetcher(LOC, row, [], {
    ...repo.proxyBackoffs,
    listForUpstream: async id => { owners.push(id); return [] },
  })
  const observer = (name: string): DialObserver => ({ beginCall: ({ upstreamId }) => {
    calls.push(`${name}:${upstreamId}`)
    return { beginAttempt: input => { calls.push(`${name}:${input.transport}`); return undefined } }
  } })
  const first = factory(row.id, observer('first'))
  const second = factory(row.id, observer('second'))
  await first('https://example.invalid/1', {})
  await second('https://example.invalid/2', {})
  await first('https://example.invalid/3', {})
  expect(calls).toEqual(['first:up_test', 'first:direct_fetch', 'second:up_test', 'second:direct_fetch', 'first:up_test', 'first:direct_fetch'])
  expect(owners).toEqual(['up_test', 'up_test', 'up_test'])
})

for (const list of [[], [{ id: 'direct_fetch', colos: ['elsewhere'] }]]) {
  test(`single authoritative ${list.length ? 'colo-excluded' : 'empty'} fallback retains direct-connect body policy`, async () => {
    const row = upstreamRow({ proxyFallbackList: list })
    const factory = createSingleUpstreamFetcher(LOC, row, [], repo.proxyBackoffs)
    await expect(factory(row.id)('https://example.invalid', { method: 'POST', body: new ReadableStream() })).rejects.toThrow('streaming request bodies are not replayable')
  })
}

test('standalone preparation and authoritative factories still require initialized repo', async () => {
  __resetPlatformForTests()
  const row = upstreamRow({ proxyFallbackList: [{ id: 'direct_fetch' }] })
  await expect(preparePerRequestFetcher(LOC, [row], { proxies: { list: async () => [] }, proxyBackoffs: repo.proxyBackoffs })).rejects.toThrow('Repo not initialized')
  expect(() => createSingleUpstreamFetcher(LOC, row, [], repo.proxyBackoffs)).toThrow('Repo not initialized')
})
