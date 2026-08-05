// Gb integration tests for ClaudeCodeProvider.
//
// Strategy: in-memory UpstreamRepo shim wired via initUpstreamRepo(), plus a
// per-test fake fetcher that dispatches on URL. No global fetch mocking (see
// bun_mock_module_unrestorable memory).
//
// Covered scenarios:
//   1. Happy-path 200 messages call → response + quota headers persisted.
//   2. 401 (non-terminal) → invalidate + refresh + retry once → 200.
//   3. 401 twice → propagated to caller (no infinite loop).
//   4. Terminal OAuth refresh (invalid_grant retry-race exhausted) → 503 +
//      account flipped to refresh_failed.
//   5. setup-token expired at fetch time → 503, not a wire round-trip.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { CLAUDE_CODE_OAUTH_TOKEN_URL } from '../constants'
import type { Fetcher } from '../fetcher'
import { ClaudeCodeProvider } from '../provider'
import type { ClaudeCodeUpstreamState } from '../state'
import type { UpstreamRepo } from '@vibe-core/upstream-repo'
import { initUpstreamRepo, UpstreamGoneError } from '@vibe-core/upstream-repo'
import type { UpstreamRecord } from '@vibe-llm/protocols/common'
import type { ProviderRequest } from '@vibe-llm/provider-llm'

const ANTHROPIC_MESSAGES = 'https://api.anthropic.com/v1/messages?beta=true'
const ANTHROPIC_MODELS = 'https://api.anthropic.com/v1/models?limit=100'

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

const UPSTREAM_ID = 'ups_cc_test'
const ACCOUNT_UUID = '00000000-0000-4000-8000-000000000001'

const baseRecord = (
  overrides: Partial<ClaudeCodeUpstreamState['accounts'][number]> = {},
): UpstreamRecord<ClaudeCodeUpstreamState> => ({
  id: UPSTREAM_ID,
  provider: 'claude-code',
  name: 'test-cc',
  enabled: true,
  sortOrder: 0,
  config: {
    accounts: [
      {
        email: 'test@example.com',
        accountUuid: ACCOUNT_UUID,
        organizationUuid: null,
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
      },
    ],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  state: {
    accounts: [
      {
        accountUuid: ACCOUNT_UUID,
        tokenKind: 'oauth',
        refreshToken: 'rt_initial',
        state: 'active',
        stateUpdatedAt: '2026-01-01T00:00:00.000Z',
        accessToken: {
          token: 'at_initial',
          expiresAt: Date.now() + 60 * 60 * 1000,
          refreshedAt: '2026-01-01T00:00:00.000Z',
        },
        quotaSnapshot: null,
        usageProbeSnapshot: null,
        ...overrides,
      } as ClaudeCodeUpstreamState['accounts'][number],
    ],
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const CATALOG_JSON = {
  data: [
    {
      id: 'claude-opus-4-7',
      display_name: 'Claude Opus 4.7',
      max_input_tokens: 200000,
    },
    {
      id: 'claude-sonnet-4-5-20250929',
      display_name: 'Claude Sonnet 4.5',
      max_input_tokens: 200000,
    },
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
}

const okSSE = (extraHeaders?: Record<string, string>): Response =>
  new Response('data: {"type":"message_stop"}\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...(extraHeaders ?? {}) },
  })

const okJson = (obj: unknown): Response =>
  new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const makeHarness = (
  onMessages: (call: Recorded, attempt: number) => Response,
  oauthResponder: () => Response = () =>
    okJson({
      access_token: 'at_refreshed',
      refresh_token: 'rt_rotated',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'user:inference',
    }),
): FetcherHarness => {
  const calls: Recorded[] = []
  let messagesAttempt = 0
  const fetcher: Fetcher = async (url, init) => {
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0])
    const record: Recorded = {
      url: url.toString(),
      method,
      authorization: headers.get('authorization'),
      bodyText: typeof init?.body === 'string' ? init.body : null,
    }
    calls.push(record)
    const u = url.toString()
    if (u === ANTHROPIC_MODELS) return okJson(CATALOG_JSON)
    if (u === CLAUDE_CODE_OAUTH_TOKEN_URL) return oauthResponder()
    if (u === ANTHROPIC_MESSAGES) {
      messagesAttempt++
      return onMessages(record, messagesAttempt)
    }
    return new Response('unexpected', { status: 500 })
  }
  return { fetcher, calls }
}

// ─── Setup / teardown ──────────────────────────────────────────────────────

let repo: InMemoryUpstreamRepo

beforeEach(() => {
  repo = new InMemoryUpstreamRepo()
  initUpstreamRepo(() => repo)
})

afterEach(() => {
  initUpstreamRepo(() => {
    throw new Error('UpstreamRepo torn down')
  })
})

// ─── Helpers ───────────────────────────────────────────────────────────────

const makeRequest = (): ProviderRequest => ({
  endpoint: 'messages',
  payload: {
    model: 'claude-opus-4-7',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
  },
  headers: new Headers(),
  sourceApi: 'anthropic',
})

const settleBackground = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

// ─── Tests ─────────────────────────────────────────────────────────────────

test('200 messages call → ok + quota snapshot persisted in background', async () => {
  repo.put(baseRecord())
  const nowSec = Math.floor(Date.now() / 1000)
  const harness = makeHarness(() =>
    okSSE({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-reset': String(nowSec + 3600),
      'anthropic-ratelimit-unified-5h-utilization': '0.3',
      'anthropic-ratelimit-unified-5h-reset': String(nowSec + 1800),
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    }),
  )
  const provider = new ClaudeCodeProvider(baseRecord(), harness.fetcher)
  const resp = await provider.fetch(makeRequest())

  expect(resp.status).toBe(200)
  expect(resp.body).not.toBeNull()

  await settleBackground()

  const fresh = await repo.getById<ClaudeCodeUpstreamState>(UPSTREAM_ID)
  const snap = fresh!.state.accounts[0]!.quotaSnapshot
  expect(snap).not.toBeNull()
  expect(snap!.data.status).toBe('allowed')
  expect(snap!.data.fiveHour?.utilization).toBe(0.3)
})

test('401 → invalidate + refresh + retry once → 200', async () => {
  repo.put(baseRecord())
  const harness = makeHarness((_call, attempt) => {
    if (attempt === 1) {
      return new Response(
        JSON.stringify({ error: { type: 'authentication_error', message: 'stale' } }),
        { status: 401 },
      )
    }
    return okSSE()
  })
  const provider = new ClaudeCodeProvider(baseRecord(), harness.fetcher)
  const resp = await provider.fetch(makeRequest())

  expect(resp.status).toBe(200)

  const messagesCalls = harness.calls.filter((c) => c.url === ANTHROPIC_MESSAGES)
  expect(messagesCalls).toHaveLength(2)

  const oauthCalls = harness.calls.filter((c) => c.url === CLAUDE_CODE_OAUTH_TOKEN_URL)
  expect(oauthCalls).toHaveLength(1)

  expect(messagesCalls[0]!.authorization).toBe('Bearer at_initial')
  expect(messagesCalls[1]!.authorization).toBe('Bearer at_refreshed')

  await settleBackground()

  const fresh = await repo.getById<ClaudeCodeUpstreamState>(UPSTREAM_ID)
  const acct = fresh!.state.accounts[0]!
  expect(acct.tokenKind).toBe('oauth')
  if (acct.tokenKind === 'oauth') {
    expect(acct.refreshToken).toBe('rt_rotated')
  }
})

test('401 twice → propagated to caller', async () => {
  repo.put(baseRecord())
  const harness = makeHarness(() =>
    new Response(
      JSON.stringify({ error: { type: 'authentication_error', message: 'stale' } }),
      { status: 401 },
    ),
  )
  const provider = new ClaudeCodeProvider(baseRecord(), harness.fetcher)
  const resp = await provider.fetch(makeRequest())

  expect(resp.status).toBe(401)

  const messagesCalls = harness.calls.filter((c) => c.url === ANTHROPIC_MESSAGES)
  expect(messagesCalls).toHaveLength(2)
})

test('terminal OAuth refresh (invalid_grant) → 503 + refresh_failed', async () => {
  // Pre-expire the cached access token so we force a mint round-trip on the
  // first call. OAuth responds `invalid_grant` → access-token layer flips
  // account to refresh_failed and throws ClaudeCodeOAuthSessionTerminatedError;
  // fetch layer catches → synthetic 503.
  repo.put(
    baseRecord({
      accessToken: {
        token: 'at_stale',
        expiresAt: Date.now() - 60_000,
        refreshedAt: '2025-12-31T00:00:00.000Z',
      },
    }),
  )
  const harness = makeHarness(
    () => okSSE(),
    () =>
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'refresh_token expired' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
  )
  const provider = new ClaudeCodeProvider(baseRecord({
    accessToken: {
      token: 'at_stale',
      expiresAt: Date.now() - 60_000,
      refreshedAt: '2025-12-31T00:00:00.000Z',
    },
  }), harness.fetcher)
  const resp = await provider.fetch(makeRequest())

  expect(resp.status).toBe(503)

  const messagesCalls = harness.calls.filter((c) => c.url === ANTHROPIC_MESSAGES)
  expect(messagesCalls).toHaveLength(0) // never reached the wire

  const fresh = await repo.getById<ClaudeCodeUpstreamState>(UPSTREAM_ID)
  const acct = fresh!.state.accounts[0]!
  expect(acct.state).toBe('refresh_failed')
  expect(acct.accessToken).toBeNull()
})

test('setup-token expired → 503, no wire round-trip', async () => {
  repo.put(
    baseRecord({
      tokenKind: 'setup-token',
      refreshToken: null,
      accessToken: {
        token: 'at_setup_expired',
        expiresAt: Date.now() - 60_000,
        refreshedAt: '2025-12-31T00:00:00.000Z',
      },
    } as Partial<ClaudeCodeUpstreamState['accounts'][number]>),
  )
  const harness = makeHarness(() => okSSE())
  const provider = new ClaudeCodeProvider(
    baseRecord({
      tokenKind: 'setup-token',
      refreshToken: null,
      accessToken: {
        token: 'at_setup_expired',
        expiresAt: Date.now() - 60_000,
        refreshedAt: '2025-12-31T00:00:00.000Z',
      },
    } as Partial<ClaudeCodeUpstreamState['accounts'][number]>),
    harness.fetcher,
  )
  const resp = await provider.fetch(makeRequest())

  expect(resp.status).toBe(503)

  const messagesCalls = harness.calls.filter((c) => c.url === ANTHROPIC_MESSAGES)
  expect(messagesCalls).toHaveLength(0)

  const oauthCalls = harness.calls.filter((c) => c.url === CLAUDE_CODE_OAUTH_TOKEN_URL)
  expect(oauthCalls).toHaveLength(0) // setup-token never refreshes

  const fresh = await repo.getById<ClaudeCodeUpstreamState>(UPSTREAM_ID)
  const acct = fresh!.state.accounts[0]!
  expect(acct.state).toBe('refresh_failed')
})
