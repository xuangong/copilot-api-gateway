/**
 * The token cache is clock-driven: it trusts `expires_at`. Copilot can revoke a
 * session before then, so callers that observe a 401/403 pass
 * `{ forceRefresh: true }` to demand a new exchange. These tests pin the guards
 * that keep that escape hatch from becoming a GitHub hammer.
 *
 * The cache is module-level state, so every test uses its own GitHub token to
 * get its own key.
 */
import { test, expect } from 'bun:test'
import {
  getCachedCopilotToken,
  invalidateCopilotToken,
} from '../../src/shared/copilot-token-cache.ts'
import type { Fetcher } from '@vibe-core/upstream'

const HOST = 'github.com'
const HOUR = 3600

/** Hands out tid_1, tid_2, … so a re-exchange is visible in the result. */
function countingExchange(): { fetcher: Fetcher; count: () => number } {
  let n = 0
  const fetcher = (async () => {
    n++
    return Response.json({
      token: `tid_${n}`,
      expires_at: Math.floor(Date.now() / 1000) + HOUR,
      refresh_in: HOUR,
      endpoints: { api: 'https://api.githubcopilot.com' },
    })
  }) as Fetcher
  return { fetcher, count: () => n }
}

test('a fresh entry is served from cache without touching GitHub', async () => {
  const { fetcher, count } = countingExchange()
  const first = await getCachedCopilotToken('gh_plain', 'individual', HOST, fetcher)
  const second = await getCachedCopilotToken('gh_plain', 'individual', HOST, fetcher)
  expect(second.token).toBe(first.token)
  expect(count()).toBe(1)
})

test('forceRefresh within the cooldown returns the cached token instead of re-exchanging', async () => {
  // A token exchanged seconds ago is almost certainly not revoked, so this
  // rejection is more likely a real entitlement failure that a new token will
  // not fix. Handing back the same token is also the provider's signal to stop
  // retrying rather than replay a request that will fail identically.
  const { fetcher, count } = countingExchange()
  await getCachedCopilotToken('gh_cooldown', 'individual', HOST, fetcher)
  const forced = await getCachedCopilotToken('gh_cooldown', 'individual', HOST, fetcher, {
    forceRefresh: true,
  })
  expect(forced.token).toBe('tid_1')
  expect(count()).toBe(1)
})

test('forceRefresh past the cooldown exchanges a new token', async () => {
  const { fetcher, count } = countingExchange()
  await getCachedCopilotToken('gh_elapsed', 'individual', HOST, fetcher)

  // Age the cache past REFRESH_COOLDOWN_MS without aging `expires_at` out of
  // freshness — the whole point is a token the clock still considers valid.
  const realNow = Date.now
  Date.now = () => realNow() + 90_000
  try {
    const forced = await getCachedCopilotToken('gh_elapsed', 'individual', HOST, fetcher, {
      forceRefresh: true,
    })
    expect(forced.token).toBe('tid_2')
  } finally {
    Date.now = realNow
  }
  expect(count()).toBe(2)
})

test('forceRefresh with nothing cached just exchanges', async () => {
  const { fetcher, count } = countingExchange()
  const session = await getCachedCopilotToken('gh_cold', 'individual', HOST, fetcher, {
    forceRefresh: true,
  })
  expect(session.token).toBe('tid_1')
  expect(count()).toBe(1)
})

test('concurrent callers share one exchange', async () => {
  // A revoked session rejects every in-flight request at once; without
  // de-duplication each one would open its own round trip to GitHub.
  const { fetcher, count } = countingExchange()
  const sessions = await Promise.all(
    Array.from({ length: 5 }, () => getCachedCopilotToken('gh_burst', 'individual', HOST, fetcher)),
  )
  expect(new Set(sessions.map((s) => s.token)).size).toBe(1)
  expect(count()).toBe(1)
})

test('invalidate drops the entry and its cooldown', async () => {
  const { fetcher, count } = countingExchange()
  await getCachedCopilotToken('gh_invalidate', 'individual', HOST, fetcher)
  await invalidateCopilotToken('gh_invalidate', 'individual', HOST)
  const after = await getCachedCopilotToken('gh_invalidate', 'individual', HOST, fetcher)
  expect(after.token).toBe('tid_2')
  expect(count()).toBe(2)
})

test('a failed exchange starts no cooldown', async () => {
  // Otherwise one GitHub outage would suppress recovery attempts for a minute
  // while the caller holds nothing usable.
  let attempts = 0
  const fetcher = (async () => {
    attempts++
    return attempts === 1
      ? new Response('nope', { status: 503 })
      : Response.json({
          token: 'tid_ok',
          expires_at: Math.floor(Date.now() / 1000) + HOUR,
          refresh_in: HOUR,
        })
  }) as Fetcher

  await expect(getCachedCopilotToken('gh_outage', 'individual', HOST, fetcher)).rejects.toThrow(
    /503/,
  )
  const session = await getCachedCopilotToken('gh_outage', 'individual', HOST, fetcher, {
    forceRefresh: true,
  })
  expect(session.token).toBe('tid_ok')
})

test('the tenant-advertised endpoint wins over the accountType default', async () => {
  const fetcher = (async () =>
    Response.json({
      token: 'tid_ghe',
      expires_at: Math.floor(Date.now() / 1000) + HOUR,
      refresh_in: HOUR,
      endpoints: { api: 'https://copilot-api.msft.ghe.com' },
    })) as Fetcher
  const session = await getCachedCopilotToken('gh_ghe', 'business', 'msft.ghe.com', fetcher)
  expect(session.apiEndpoint).toBe('https://copilot-api.msft.ghe.com')
})
