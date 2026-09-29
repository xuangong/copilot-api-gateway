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

test('fetch — auth refresh resends the first native body text with fresh auth headers', async () => {
  const calls: Array<{ url: string; token: string | null; body: BodyInit | null | undefined; requestId: string | null; taskId: string | null; integrationId: string | null }> = []
  const input = { value: 'first', toJSON() { serializations++; return this.value } }
  let serializations = 0
  let streamReads = 0
  const payload = Object.defineProperty({ model: 'gpt-4o', input }, 'stream', {
    get() { streamReads++; return false },
  })
  const fetcher: Fetcher = async (url, init) => {
    const headers = new Headers(init.headers)
    calls.push({
      url: String(url),
      token: headers.get('authorization'),
      body: init.body,
      requestId: headers.get('x-request-id'),
      taskId: headers.get('x-agent-task-id'),
      integrationId: headers.get('copilot-integration-id'),
    })
    if (calls.length === 1) {
      input.value = 'changed after send'
      return new Response(DENIED, { status: 403 })
    }
    return new Response('{}', { status: 200 })
  }
  const provider = new CopilotProvider({
    copilotToken: 'stale', accountType: 'individual',
    refreshSession: async () => ({ token: 'fresh', baseUrl: 'https://tenant.example' }),
  }, fetcher)

  const response = await provider.fetch({
    endpoint: 'embeddings',
    payload,
    headers: new Headers({ 'copilot-integration-id': '' }),
    sourceApi: 'openai',
  })

  expect(response.status).toBe(200)
  expect(serializations).toBe(1)
  expect(streamReads).toBe(1)
  expect(calls.map((call) => call.body)).toEqual(['{"model":"gpt-4o","input":"first"}', '{"model":"gpt-4o","input":"first"}'])
  expect(calls.map((call) => call.token)).toEqual(['Bearer stale', 'Bearer fresh'])
  expect(calls[1]?.url).toBe('https://tenant.example/embeddings')
  expect(calls[0]?.requestId).toBe(calls[0]?.taskId)
  expect(calls[1]?.requestId).toBe(calls[1]?.taskId)
  expect(calls[0]?.requestId).not.toBe(calls[1]?.requestId)
  expect(calls.map((call) => call.integrationId)).toEqual([null, null])
})

test('fetch — a successful undefined JSON representation stays undefined after refresh', async () => {
  const bodies: Array<BodyInit | null | undefined> = []
  let serializations = 0
  const fetcher: Fetcher = async (_url, init) => {
    bodies.push(init.body)
    return new Response(bodies.length === 1 ? DENIED : '{}', { status: bodies.length === 1 ? 401 : 200 })
  }
  const provider = new CopilotProvider({
    copilotToken: 'stale', accountType: 'individual',
    refreshSession: async () => ({ token: 'fresh' }),
  }, fetcher)

  const response = await provider.fetch({
    endpoint: 'embeddings',
    payload: { model: 'gpt-4o', toJSON() { serializations++; return undefined } },
    headers: new Headers(),
    sourceApi: 'openai',
  })

  expect(response.status).toBe(200)
  expect(serializations).toBe(1)
  expect(bodies).toEqual([undefined, undefined])
})

test('concurrent auth retries keep each request body isolated', async () => {
  const attempts = new Map<string, string[]>()
  const inputs = {
    a: { value: 'a-first', toJSON() { aSerializations++; return this.value } },
    b: { value: 'b-first', toJSON() { bSerializations++; return this.value } },
  }
  let aSerializations = 0
  let bSerializations = 0
  let refreshes = 0
  const fetcher: Fetcher = async (_url, init) => {
    const body = String(init.body)
    const parsed = JSON.parse(body) as { id: 'a' | 'b' }
    const seen = attempts.get(parsed.id) ?? []
    seen.push(body)
    attempts.set(parsed.id, seen)
    if (seen.length === 1) {
      inputs[parsed.id].value = `${parsed.id}-changed`
      return new Response(DENIED, { status: 403 })
    }
    return new Response('{}', { status: 200 })
  }
  const provider = new CopilotProvider({
    copilotToken: 'stale', accountType: 'individual',
    refreshSession: async () => ({ token: `fresh-${++refreshes}` }),
  }, fetcher)
  const call = (id: 'a' | 'b') => provider.fetch({
    endpoint: 'embeddings', payload: { model: 'gpt-4o', id, input: inputs[id] },
    headers: new Headers(), sourceApi: 'openai',
  })

  const responses = await Promise.all([call('a'), call('b')])
  expect(responses.map((response) => response.status)).toEqual([200, 200])
  expect(attempts.get('a')).toEqual(['{"model":"gpt-4o","id":"a","input":"a-first"}', '{"model":"gpt-4o","id":"a","input":"a-first"}'])
  expect(attempts.get('b')).toEqual(['{"model":"gpt-4o","id":"b","input":"b-first"}', '{"model":"gpt-4o","id":"b","input":"b-first"}'])
  expect([aSerializations, bSerializations]).toEqual([1, 1])
})
