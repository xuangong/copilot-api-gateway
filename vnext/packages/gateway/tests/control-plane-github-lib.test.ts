/**
 * addGithubAccount → mirrorCopilotUpstream chain persistence.
 *
 * Real BunSqliteRepo: proxy_fallback_list_json is a TEXT column holding JSON,
 * and the whole point of these cases is that the round-trip through it
 * preserves the chain — including each entry's `colos`, which the write path
 * normalizes (uppercased, deduped) so a row written here is byte-identical to
 * one written through PATCH /api/upstreams/:id.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo } from '../src/repo/index.ts'
import { addGithubAccount, copilotUpstreamRowId } from '../src/control-plane/lib/github.ts'
import type { GitHubUser } from '../src/repo/types.ts'
import type { GitHubAccountId, UserId } from '../src/repo/branded-ids.ts'

const USER: GitHubUser = {
  id: 42 as GitHubAccountId,
  login: 'octo',
  name: 'Octo Cat',
  avatar_url: 'https://avatars/octo.png',
}
const OWNER = 'u1' as UserId
const ROW = () => copilotUpstreamRowId(OWNER, USER.id)

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  initRepo(repo)
})

test('a submitted chain lands on the mirrored upstream row', async () => {
  await addGithubAccount('gho_abc', USER, 'individual', OWNER, {
    githubHost: 'github.com',
    source: 'device-flow',
    proxyFallbackList: [{ id: 'px_a', colos: ['lax'] }],
  })
  const row = await repo.upstreams.getById(ROW())
  expect(row?.proxyFallbackList).toEqual([{ id: 'px_a', colos: ['LAX'] }])
})

test('omitting the chain leaves an existing row-level chain intact', async () => {
  await addGithubAccount('gho_abc', USER, 'individual', OWNER, {
    proxyFallbackList: [{ id: 'px_a' }],
  })
  // Re-login without a chain — e.g. the token expired and the user just
  // clicked through the wizard again.
  await addGithubAccount('gho_def', USER, 'individual', OWNER, {})
  const row = await repo.upstreams.getById(ROW())
  expect(row?.proxyFallbackList).toEqual([{ id: 'px_a' }])
})

test('a new submitted chain overwrites the previous one', async () => {
  await addGithubAccount('gho_abc', USER, 'individual', OWNER, {
    proxyFallbackList: [{ id: 'px_a' }],
  })
  await addGithubAccount('gho_abc', USER, 'individual', OWNER, {
    proxyFallbackList: [{ id: 'px_b' }],
  })
  const row = await repo.upstreams.getById(ROW())
  expect(row?.proxyFallbackList).toEqual([{ id: 'px_b' }])
})

test("an explicitly empty chain clears the row's chain", async () => {
  await addGithubAccount('gho_abc', USER, 'individual', OWNER, {
    proxyFallbackList: [{ id: 'px_a' }],
  })
  await addGithubAccount('gho_abc', USER, 'individual', OWNER, {
    proxyFallbackList: [],
  })
  const row = await repo.upstreams.getById(ROW())
  expect(row?.proxyFallbackList).toEqual([])
})
