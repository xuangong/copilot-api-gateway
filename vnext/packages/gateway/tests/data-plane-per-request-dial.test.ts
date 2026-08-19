/**
 * createPerRequestFetcher — the malformed-proxy branch must name the offending
 * proxy id without echoing the proxy URI. The URI carries the proxy password in
 * its userinfo, and this error reaches 5xx response bodies and logs.
 *
 * Backed by a real BunSqliteRepo so the malformed row travels the actual
 * column/JSON plumbing into loadProxyCatalog. mock.module() is not used — it
 * leaks across test files in Bun 1.3.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo, type UpstreamRecord } from '../src/repo/index.ts'
import type { UserId } from '../src/repo/branded-ids.ts'
import { createPerRequestFetcher } from '../src/data-plane/dial/per-request.ts'

const LOC = 'test-colo'
const OWNER = 'u1' as UserId
const NOW = '2026-01-01T00:00:00.000Z'

/** Fake password, and a port outside 1..65535 so the URI fails to parse. */
const FAKE_PASSWORD = 'not-a-real-password-3f9c'
const MALFORMED_URL = `trojan://${FAKE_PASSWORD}@node.example.com:99999`

let repo: SqliteRepo

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
