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

const baseRecord = (): UpstreamRecord<CodexUpstreamState> => ({
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
        quotaSnapshot: null,
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
    const headers = new Headers(init?.headers as HeadersInit)
    const record: Recorded = {
      url: url.toString(),
      method,
      authorization: headers.get('authorization'),
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
      u === `${CODEX_BACKEND_BASE}${CODEX_RESPONSES_COMPACT_PATH}`
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
})

afterEach(() => {
  // Reset the accessor between tests so a stale repo can't leak.
  initUpstreamRepo(() => { throw new Error('UpstreamRepo torn down') })
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

// Give registerBackgroundWrite's fire-and-forget promise a tick to land in
// the in-memory repo.
const settleBackground = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 5))
}

// ─── Tests ─────────────────────────────────────────────────────────────────

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
