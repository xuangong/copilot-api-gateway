/**
 * Revoked-session recovery: Copilot can invalidate a session token before its
 * advertised `expires_at`, and the gateway's token cache is clock-driven — so
 * without an observed-rejection path the provider would serve the dead token
 * until it aged out, 401/403-ing every request in between.
 *
 * These tests drive CopilotProvider through an injected fetcher (never
 * mock.module — Bun 1.3 cannot restore module mocks between files).
 */
import { test, expect } from 'bun:test'
import { CopilotProvider } from '../src/provider'
import type { Fetcher } from '@vibe-core/upstream'

const MODELS_OK = '{"data":[{"id":"gpt-4o","name":"GPT-4o"}]}'
const DENIED = '{"error":{"message":"apiKey is valid but lacks permission for this resource"}}'

interface Call {
  url: string
  token: string | null
}

/** Records every hop and replays `statuses` in order, holding the last one. */
function recordingFetcher(statuses: number[]): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const auth = new Headers(init?.headers).get('authorization')
    calls.push({ url, token: auth?.replace(/^Bearer /, '') ?? null })
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 200
    return status === 200
      ? new Response(MODELS_OK, { status, headers: { 'content-type': 'application/json' } })
      : new Response(DENIED, { status, headers: { 'content-type': 'application/json' } })
  }) as Fetcher
  return { fetcher, calls }
}

function providerWithRefresh(
  statuses: number[],
  refresh: () => Promise<{ token: string; baseUrl?: string }>,
): { provider: CopilotProvider; calls: Call[] } {
  const { fetcher, calls } = recordingFetcher(statuses)
  const provider = new CopilotProvider(
    { copilotToken: 'stale', accountType: 'individual', refreshSession: refresh },
    fetcher,
  )
  return { provider, calls }
}

test('getModels — a 403 re-exchanges the session and replays with the new token', async () => {
  let refreshes = 0
  const { provider, calls } = providerWithRefresh([403, 200], async () => {
    refreshes++
    return { token: 'fresh' }
  })

  const models = await provider.getModels()

  expect(models.data[0]?.id).toBe('gpt-4o')
  expect(refreshes).toBe(1)
  expect(calls.map((c) => c.token)).toEqual(['stale', 'fresh'])
})

test('getModels — a 401 recovers the same way', async () => {
  const { provider, calls } = providerWithRefresh([401, 200], async () => ({ token: 'fresh' }))
  await provider.getModels()
  expect(calls.map((c) => c.token)).toEqual(['stale', 'fresh'])
})

test('getModels — retries exactly once, then surfaces the rejection', async () => {
  const { provider, calls } = providerWithRefresh([403, 403], async () => ({ token: 'fresh' }))
  await expect(provider.getModels()).rejects.toThrow()
  expect(calls).toHaveLength(2)
})

test('getModels — an unchanged token means the cache declined; do not replay', async () => {
  // The token cache rate-limits forced exchanges, so a 403 arriving moments
  // after a successful exchange hands back the same token. That is the cache
  // saying "this rejection is not staleness" — replaying would just repeat a
  // request we already know fails.
  const { provider, calls } = providerWithRefresh([403, 200], async () => ({ token: 'stale' }))
  await expect(provider.getModels()).rejects.toThrow()
  expect(calls).toHaveLength(1)
})

test('getModels — a failing re-exchange surfaces the upstream rejection, not the refresh error', async () => {
  const { provider, calls } = providerWithRefresh([403], async () => {
    throw new Error('github unreachable')
  })
  await expect(provider.getModels()).rejects.toThrow(/Failed to get models/)
  expect(calls).toHaveLength(1)
})

test('getModels — without a refresh hook the rejection passes straight through', async () => {
  // The per-request-token path: no GitHub credential to re-exchange from.
  const { fetcher, calls } = recordingFetcher([403])
  const provider = new CopilotProvider({ copilotToken: 'stale', accountType: 'individual' }, fetcher)
  await expect(provider.getModels()).rejects.toThrow()
  expect(calls).toHaveLength(1)
})

test('getModels — a non-auth failure is never retried', async () => {
  const { provider, calls } = providerWithRefresh([400, 200], async () => ({ token: 'fresh' }))
  await expect(provider.getModels()).rejects.toThrow()
  expect(calls).toHaveLength(1)
})

test('fetch — a 403 on the inference call re-exchanges and replays once', async () => {
  const { provider, calls } = providerWithRefresh([403, 200], async () => ({ token: 'fresh' }))

  const res = await provider.fetch({
    endpoint: 'chat_completions',
    payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    headers: new Headers({ 'content-type': 'application/json' }),
    sourceApi: 'openai',
    flags: { isStreaming: false },
  })

  expect(res.status).toBe(200)
  expect(calls.map((c) => c.url)).toEqual([
    'https://api.githubcopilot.com/chat/completions',
    'https://api.githubcopilot.com/chat/completions',
  ])
  expect(calls.map((c) => c.token)).toEqual(['stale', 'fresh'])
})

test('fetch — a tenant-advertised base URL from the refresh is adopted', async () => {
  const { provider, calls } = providerWithRefresh([403, 200], async () => ({
    token: 'fresh',
    baseUrl: 'https://copilot-api.msft.ghe.com',
  }))

  await provider.fetch({
    endpoint: 'chat_completions',
    payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    headers: new Headers({ 'content-type': 'application/json' }),
    sourceApi: 'openai',
    flags: { isStreaming: false },
  })

  expect(calls[1]?.url).toBe('https://copilot-api.msft.ghe.com/chat/completions')
})
