// F3b E2.5 integration tests for CodexProvider.
//
// Strategy: in-memory UpstreamRepo shim wired via initUpstreamRepo(), plus a
// per-test fake fetcher that dispatches on URL. No global fetch mocking (see
// bun_mock_module_unrestorable memory).
//
// Covered scenarios:
//   1. Happy-path 200 responses call → ProviderResponse ok + quota headers
//      trigger background persist.
//   2. 401 (non-terminal) → invalidate + refresh + retry once → 200.
//   3. 401 twice → propagated to caller (no infinite loop).
//   4. Terminal 401 (`token_invalidated`) → effects.persistTerminalState +
//      synthetic 503 returned.
//   5. compact action → hits /codex/responses/compact.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  CODEX_ALPHA_SEARCH_PATH,
  CODEX_BACKEND_BASE,
  CODEX_MODELS_PATH,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_RESPONSES_COMPACT_PATH,
  CODEX_RESPONSES_PATH,
} from '../constants'
import type { Fetcher } from '../fetcher'
import { CodexProvider } from '../provider'
import type { CodexUpstreamState } from '../state'
import type { UpstreamRepo } from '@vibe-core/upstream-repo'
import { initUpstreamRepo, UpstreamGoneError } from '@vibe-core/upstream-repo'
import { __resetPlatformForTests, initBackground } from '@vibe-core/platform'
import type { UpstreamRecord } from '@vibe-llm/protocols/common'
import type { ProviderRequest } from '@vibe-llm/provider-llm'

// ─── In-memory UpstreamRepo ────────────────────────────────────────────────

class InMemoryUpstreamRepo implements UpstreamRepo {
  private rows = new Map<string, UpstreamRecord<unknown>>()

  put(record: UpstreamRecord<unknown>): void {
    this.rows.set(record.id, structuredClone(record))
  }

  async getById<TState = unknown>(id: string): Promise<UpstreamRecord<TState> | null> {
    const row = this.rows.get(id)
    return row ? (structuredClone(row) as UpstreamRecord<TState>) : null
  }

  async saveState<TState>(id: string, updater: (current: TState) => TState): Promise<void> {
    const row = this.rows.get(id)
    if (!row) throw new UpstreamGoneError(id)
    const next = updater(structuredClone(row.state) as TState)
    row.state = next
    row.updatedAt = new Date().toISOString()
    this.rows.set(id, row)
  }
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const UPSTREAM_ID = 'ups_codex_test'
const ACCOUNT_ID = 'acct_test'

const baseRecord = (
  quotaSnapshot: CodexUpstreamState['accounts'][number]['quotaSnapshot'] = null,
): UpstreamRecord<CodexUpstreamState> => ({
  id: UPSTREAM_ID,
  provider: 'codex',
  name: 'test-codex',
  enabled: true,
  sortOrder: 0,
  config: {
    accounts: [
      {
        email: 'test@example.com',
        chatgptAccountId: ACCOUNT_ID,
        chatgptUserId: 'user_test',
        planType: 'plus',
      },
    ],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  state: {
    accounts: [
      {
        chatgptAccountId: ACCOUNT_ID,
        refresh_token: 'rt_initial',
        state: 'active',
        state_updated_at: '2026-01-01T00:00:00.000Z',
        openaiDeviceId: 'dev_test',
        // Pre-populate a fresh access token so getModels / fetch skip the
        // OAuth mint step in the happy-path cases.
        accessToken: {
          token: 'at_initial',
          expiresAt: Date.now() + 60 * 60 * 1000,
          refreshedAt: '2026-01-01T00:00:00.000Z',
        },
        quotaSnapshot,
      },
    ],
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const CATALOG_JSON = {
  models: [
    { slug: 'gpt-5', display_name: 'GPT-5', context_window: 128000 },
    { slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', context_window: 128000 },
  ],
}

// ─── Fetcher scaffolding ───────────────────────────────────────────────────

interface Recorded {
  url: string
  method: string
  authorization: string | null
  sessionId: string | null
  threadId: string | null
  bodyText: string | null
}

interface FetcherHarness {
  fetcher: Fetcher
  calls: Recorded[]
  onResponses: (call: Recorded, attempt: number) => Response
}

const okSSE = (): Response =>
  new Response('data: {"type":"response.completed"}\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

const okJson = (obj: unknown, extra?: Record<string, string>): Response =>
  new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(extra ?? {}) },
  })

const makeHarness = (onResponses: FetcherHarness['onResponses']): FetcherHarness => {
  const calls: Recorded[] = []
  let responsesAttempt = 0
  const fetcher: Fetcher = async (url, init) => {
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0])
    const record: Recorded = {
      url: url.toString(),
      method,
      authorization: headers.get('authorization'),
      sessionId: headers.get('session-id'),
      threadId: headers.get('thread-id'),
      bodyText: typeof init?.body === 'string' ? init.body : null,
    }
    calls.push(record)
    const u = url.toString()
    if (u.startsWith(`${CODEX_BACKEND_BASE}${CODEX_MODELS_PATH}`)) {
      return okJson(CATALOG_JSON)
    }
    if (u === CODEX_OAUTH_TOKEN_URL) {
      return okJson({
        access_token: 'at_refreshed',
        refresh_token: 'rt_rotated',
        id_token: 'idt_x',
        expires_in: 3600,
      })
    }
    if (
      u === `${CODEX_BACKEND_BASE}${CODEX_RESPONSES_PATH}` ||
      u === `${CODEX_BACKEND_BASE}${CODEX_RESPONSES_COMPACT_PATH}` ||
      u === `${CODEX_BACKEND_BASE}${CODEX_ALPHA_SEARCH_PATH}`
    ) {
      responsesAttempt++
      return onResponses(record, responsesAttempt)
    }
    return new Response('unexpected', { status: 500 })
  }
  return { fetcher, calls, onResponses }
}

// ─── Setup / teardown ──────────────────────────────────────────────────────

let repo: InMemoryUpstreamRepo

beforeEach(() => {
  repo = new InMemoryUpstreamRepo()
  initUpstreamRepo(() => repo)
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
})

afterEach(() => {
  // Reset the accessor between tests so a stale repo can't leak.
  initUpstreamRepo(() => { throw new Error('UpstreamRepo torn down') })
  __resetPlatformForTests()
})

// ─── Helpers ───────────────────────────────────────────────────────────────

const makeRequest = (action?: 'generate' | 'compact'): ProviderRequest => ({
  endpoint: 'responses',
  payload: {
    model: 'gpt-5',
    input: [
      { type: 'message', role: 'user', content: 'hi' },
    ],
  },
  headers: new Headers(),
  sourceApi: 'openai',
  ...(action !== undefined ? { action } : {}),
})

const makeAlphaSearchRequest = (): ProviderRequest => ({
  endpoint: 'alpha_search',
  payload: {
    model: 'gpt-5',
    id: 'req_alpha_1',
    commands: { search_query: [{ query: 'foo' }] },
  },
  headers: new Headers(),
  sourceApi: 'openai',
})

// Give registerBackgroundWrite's fire-and-forget promise a tick to land in
// the in-memory repo.
const settleBackground = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 5))
}

const legacySessionId = async (instructions: string, seed: unknown): Promise<string> => {
  const source = `${instructions}\u0001${JSON.stringify(seed)}`
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const variant = ((parseInt(hex[16] ?? '0', 16) & 3) | 8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('outgoing session header uses the legacy seed through first user and ignores tail', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() => okSSE())
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const first = makeRequest()
  const prefix = [
    { type: 'message', role: 'developer', content: 'pre' },
    { type: 'message', role: 'user', content: 'first' },
  ]
  first.payload = { model: 'gpt-5', input: prefix, instructions: 'rules\ud83d\ude00' }
  expect((await provider.fetch(first)).status).toBe(200)
  const second = makeRequest()
  second.payload = {
    model: 'gpt-5',
    input: [...prefix, { type: 'message', role: 'assistant', content: 'later' }],
    instructions: 'rules\ud83d\ude00',
  }
  expect((await provider.fetch(second)).status).toBe(200)
  const calls = harness.calls.filter((call) => call.url.endsWith(CODEX_RESPONSES_PATH))
  const firstBody = JSON.parse(calls[0]?.bodyText ?? '{}') as { input: unknown[]; instructions: string }
  const expected = await legacySessionId(firstBody.instructions, firstBody.input.slice(0, 2))
  expect(calls[0]?.sessionId).toBe(expected)
  expect(calls[0]?.threadId).toBe(expected)
  expect(calls[1]?.sessionId).toBe(expected)

  const override = makeRequest()
  override.headers.set('session-id', 'client-session')
  expect((await provider.fetch(override)).status).toBe(200)
  expect(harness.calls.filter((call) => call.url.endsWith(CODEX_RESPONSES_PATH))[2]?.sessionId).toBe('client-session')
})

test('seed stringify invokes stateful toJSON once separately from body stringify', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() => okSSE())
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  let calls = 0
  const request = makeRequest()
  request.payload = {
    model: 'gpt-5',
    input: [{ type: 'message', role: 'user', content: { toJSON: () => `value-${++calls}` } }],
  }
  expect((await provider.fetch(request)).status).toBe(200)
  expect(calls).toBe(2)
  expect(harness.calls.filter((call) => call.url.endsWith(CODEX_RESPONSES_PATH))).toHaveLength(1)
})

test('outgoing seed keeps native numeric formatting and object insertion order', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() => okSSE())
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const request = makeRequest()
  request.payload = {
    model: 'gpt-5',
    input: [{ type: 'message', role: 'user', content: { z: 1e21, a: 2 } }],
  }
  expect((await provider.fetch(request)).status).toBe(200)
  const call = harness.calls.find((entry) => entry.url.endsWith(CODEX_RESPONSES_PATH))
  const body = JSON.parse(call?.bodyText ?? '{}') as { instructions?: string; input: unknown[] }
  expect(call?.sessionId).toBe(await legacySessionId(body.instructions ?? '', body.input))
  expect(call?.bodyText).toContain('"z":1e+21,"a":2')
})

test('large outgoing seed header matches independent WebCrypto beyond fast-path threshold', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() => okSSE())
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const request = makeRequest()
  const instructions = 'z'.repeat(2 * 1024 * 1024)
  const input = [{ type: 'message', role: 'user', content: 'large' }]
  request.payload = {
    model: 'gpt-5',
    instructions,
    input,
  }
  expect((await provider.fetch(request)).status).toBe(200)
  const call = harness.calls.find((entry) => entry.url.endsWith(CODEX_RESPONSES_PATH))
  expect(call?.sessionId).toBe(await legacySessionId(instructions, input))
})

test('string input and no first user preserve existing fallback behavior', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() => okSSE())
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const stringInput = makeRequest()
  stringInput.payload = { model: 'gpt-5', input: 'hello' }
  await expect(provider.fetch(stringInput)).rejects.toThrow('opts.body.input.some is not a function')
  const noUser = makeRequest()
  noUser.payload = { model: 'gpt-5', input: [{ type: 'message', role: 'developer', content: 'only' }] }
  expect((await provider.fetch(noUser)).status).toBe(200)
  const calls = harness.calls.filter((entry) => entry.url.endsWith(CODEX_RESPONSES_PATH))
  expect(calls).toHaveLength(1)
  expect(calls[0]?.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('cyclic and BigInt seeds fail before Codex HTTP dispatch', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() => okSSE())
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const cycle: { self?: unknown } = {}
  cycle.self = cycle
  for (const content of [cycle, 1n]) {
    const request = makeRequest()
    request.payload = { model: 'gpt-5', input: [{ type: 'message', role: 'user', content }] }
    await expect(provider.fetch(request)).rejects.toThrow()
  }
  expect(harness.calls.filter((call) => call.url.endsWith(CODEX_RESPONSES_PATH))).toHaveLength(0)
})

test('200 responses call → ok + quota snapshot persisted in background', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() =>
    new Response('data: {"type":"response.completed"}\n\n', {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-codex-active-limit': 'weekly',
        'x-codex-primary-used-percent': '12.5',
      },
    }),
  )
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const resp = await provider.fetch(makeRequest())

  expect(resp.status).toBe(200)
  expect(resp.body).not.toBeNull()

  await settleBackground()

  const fresh = await repo.getById<CodexUpstreamState>(UPSTREAM_ID)
  const snap = fresh!.state.accounts[0]!.quotaSnapshot
  expect(snap).not.toBeNull()
  const entry = Object.values(snap!)[0]!
  expect(entry.data.active_limit).toBe('weekly')
  expect(entry.data.primary_used_percent).toBe(12.5)
})

test('401 → invalidate + refresh + retry once → 200', async () => {
  repo.put(baseRecord())
  const harness = makeHarness((_call, attempt) => {
    if (attempt === 1) {
      return new Response(JSON.stringify({ error: { code: 'expired_token', message: 'stale' } }), {
        status: 401,
      })
    }
    return okSSE()
  })
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const resp = await provider.fetch(makeRequest())

  expect(resp.status).toBe(200)

  const responsesCalls = harness.calls.filter((c) => c.url.endsWith(CODEX_RESPONSES_PATH))
  expect(responsesCalls).toHaveLength(2)

  const oauthCalls = harness.calls.filter((c) => c.url === CODEX_OAUTH_TOKEN_URL)
  expect(oauthCalls).toHaveLength(1)

  // Retry must use the freshly-minted token.
  expect(responsesCalls[0]!.authorization).toBe('Bearer at_initial')
  expect(responsesCalls[1]!.authorization).toBe('Bearer at_refreshed')

  await settleBackground()

  // Refresh-token rotation should have been persisted.
  const fresh = await repo.getById<CodexUpstreamState>(UPSTREAM_ID)
  expect(fresh!.state.accounts[0]!.refresh_token).toBe('rt_rotated')
})

test('401 twice → propagated to caller', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() =>
    new Response(JSON.stringify({ error: { code: 'expired_token', message: 'stale' } }), {
      status: 401,
    }),
  )
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const resp = await provider.fetch(makeRequest())

  expect(resp.status).toBe(401)

  const responsesCalls = harness.calls.filter((c) => c.url.endsWith(CODEX_RESPONSES_PATH))
  expect(responsesCalls).toHaveLength(2) // original + one retry, no third
})

test('terminal 401 (token_invalidated) → 503 + persistTerminalState', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() =>
    new Response(
      JSON.stringify({ error: { code: 'token_invalidated', message: 'session dead' } }),
      { status: 401 },
    ),
  )
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const resp = await provider.fetch(makeRequest())

  expect(resp.status).toBe(503)

  const fresh = await repo.getById<CodexUpstreamState>(UPSTREAM_ID)
  const acct = fresh!.state.accounts[0]!
  expect(acct.state).toBe('session_terminated')
  expect(acct.state_message).toBe('session dead')
  expect(acct.accessToken).toBeNull()
})

test('compact action → hits /codex/responses/compact', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() =>
    okJson({ id: 'resp_1', object: 'response', output: [] }),
  )
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const resp = await provider.fetch(makeRequest('compact'))

  expect(resp.status).toBe(200)

  const compactCalls = harness.calls.filter((c) =>
    c.url.endsWith(CODEX_RESPONSES_COMPACT_PATH),
  )
  expect(compactCalls).toHaveLength(1)
})

test('alpha_search 200 → hits /codex/alpha/search and passes body through', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() =>
    okJson({ encrypted_output: 'enc', output: 'ok', results: [] }),
  )
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const resp = await provider.fetch(makeAlphaSearchRequest())

  expect(resp.status).toBe(200)

  const alphaCalls = harness.calls.filter((c) =>
    c.url.endsWith(CODEX_ALPHA_SEARCH_PATH),
  )
  expect(alphaCalls).toHaveLength(1)
  const wireBody = JSON.parse(alphaCalls[0]!.bodyText!) as Record<string, unknown>
  expect(wireBody.model).toBe('gpt-5')
  expect(wireBody.id).toBe('req_alpha_1')
  expect(wireBody.commands).toEqual({ search_query: [{ query: 'foo' }] })
})

test('alpha_search 401 → refresh + retry once → 200', async () => {
  repo.put(baseRecord())
  const harness = makeHarness((_call, attempt) => {
    if (attempt === 1) {
      return new Response(JSON.stringify({ error: { code: 'expired_token', message: 'stale' } }), {
        status: 401,
      })
    }
    return okJson({ encrypted_output: null, output: 'ok' })
  })
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const resp = await provider.fetch(makeAlphaSearchRequest())

  expect(resp.status).toBe(200)

  const alphaCalls = harness.calls.filter((c) =>
    c.url.endsWith(CODEX_ALPHA_SEARCH_PATH),
  )
  expect(alphaCalls).toHaveLength(2)
  expect(alphaCalls[0]!.authorization).toBe('Bearer at_initial')
  expect(alphaCalls[1]!.authorization).toBe('Bearer at_refreshed')
})

test('alpha_search 401 twice → propagated to caller', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() =>
    new Response(JSON.stringify({ error: { code: 'expired_token', message: 'stale' } }), {
      status: 401,
    }),
  )
  const provider = new CodexProvider(baseRecord(), harness.fetcher)
  const resp = await provider.fetch(makeAlphaSearchRequest())

  expect(resp.status).toBe(401)

  const alphaCalls = harness.calls.filter((c) =>
    c.url.endsWith(CODEX_ALPHA_SEARCH_PATH),
  )
  expect(alphaCalls).toHaveLength(2) // original + one retry, no third
})

// ─── Pre-flight quota gate ─────────────────────────────────────────────────
// No reference implementation to port: copilot-gateway writes
// `ratelimited_until` but never reads it. The signal itself is unambiguous
// though — it is stamped only when the upstream actually answered 429 — so the
// gate mirrors the claude-code one using codex's own field.

const limitedBucket = (
  ratelimitedUntil: string | null,
): CodexUpstreamState['accounts'][number]['quotaSnapshot'] => ({
  weekly: {
    fetchedAt: Date.now(),
    data: {
      observed_at: new Date().toISOString(),
      active_limit: 'weekly',
      primary_used_percent: 100,
      ...(ratelimitedUntil === null ? {} : { ratelimited_until: ratelimitedUntil }),
    },
  },
})

const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString()

test('bucket rate-limited into the future → synthetic 429, no wire call', async () => {
  const record = baseRecord(limitedBucket(isoIn(10 * 60 * 1000)))
  repo.put(record)
  const harness = makeHarness(() => okSSE())
  const provider = new CodexProvider(record, harness.fetcher)
  const resp = await provider.fetch(makeRequest())

  expect(resp.status).toBe(429)
  const retryAfter = Number(resp.headers.get('retry-after'))
  expect(retryAfter).toBeGreaterThan(0)
  expect(retryAfter).toBeLessThanOrEqual(10 * 60)

  expect(harness.calls.filter((c) => c.url.endsWith(CODEX_RESPONSES_PATH))).toHaveLength(0)
  expect(harness.calls.filter((c) => c.url === CODEX_OAUTH_TOKEN_URL)).toHaveLength(0)
})

test('bucket whose rate limit already elapsed does not gate', async () => {
  const record = baseRecord(limitedBucket(isoIn(-60 * 1000)))
  repo.put(record)
  const harness = makeHarness(() => okSSE())
  const provider = new CodexProvider(record, harness.fetcher)
  const resp = await provider.fetch(makeRequest())

  expect(resp.status).toBe(200)
  expect(harness.calls.filter((c) => c.url.endsWith(CODEX_RESPONSES_PATH))).toHaveLength(1)
})

test('bucket at 100% used but never 429d does not gate', async () => {
  // `used_percent` is a utilization report, not a rejection. Only a real 429
  // stamps `ratelimited_until`; gating on utilization would refuse requests
  // the upstream would have served.
  const record = baseRecord(limitedBucket(null))
  repo.put(record)
  const harness = makeHarness(() => okSSE())
  const provider = new CodexProvider(record, harness.fetcher)
  const resp = await provider.fetch(makeRequest())

  expect(resp.status).toBe(200)
  expect(harness.calls.filter((c) => c.url.endsWith(CODEX_RESPONSES_PATH))).toHaveLength(1)
})
