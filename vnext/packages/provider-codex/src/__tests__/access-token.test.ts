// Unit tests for access-token.ts — put / invalidate / ensure (incl. refresh-
// race recovery). Adapted from the reference project's `access-token_test.ts`
// (vitest + createUpstreamStateRepoStub) to Bun's test runner + the vNext
// InMemoryUpstreamRepo used elsewhere in this package. See
// bun_mock_module_unrestorable memory: never use `mock.module()`; wire the
// repo via `initUpstreamRepo`.

import { afterEach, beforeEach, expect, test, describe, mock } from 'bun:test'
import {
  ensureCodexAccessToken,
  invalidateCodexAccessToken,
  putCodexAccessToken,
  type CodexAccessTokenEntry,
} from '../access-token'
import { CodexOAuthSessionTerminatedError } from '../auth/oauth'
import type { CodexUpstreamState } from '../state'
import type { UpstreamRepo } from '@vibe-core/upstream-repo'
import { initUpstreamRepo, UpstreamGoneError } from '@vibe-core/upstream-repo'
import { __resetPlatformForTests, initBackground } from '@vibe-core/platform'
import type { UpstreamRecord } from '@vibe-llm/protocols/common'

const UPSTREAM_ID = 'up_a'
const ACCOUNT_ID = 'acc_1'
const FAR_FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000

const baseAccount = () => ({
  chatgptAccountId: ACCOUNT_ID,
  refresh_token: 'rt_v1',
  state: 'active' as const,
  state_updated_at: '2026-06-01T00:00:00.000Z',
  openaiDeviceId: '11111111-2222-4333-8444-555555555555',
  accessToken: null as CodexAccessTokenEntry | null,
  quotaSnapshot: null,
})

const makeRecord = (state: CodexUpstreamState): UpstreamRecord<CodexUpstreamState> => ({
  id: UPSTREAM_ID,
  provider: 'codex',
  name: 'codex',
  enabled: true,
  sortOrder: 0,
  config: {
    accounts: [
      { email: 'a@b.com', chatgptAccountId: ACCOUNT_ID, chatgptUserId: 'usr', planType: 'plus' },
    ],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  state,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
})

// InMemoryUpstreamRepo variant that also records writes and lets tests
// override `getById` per call — needed for the refresh-race recovery
// scenarios where the second `getById` observes a sibling-rotated row.
class RecordingRepo implements UpstreamRepo {
  row: UpstreamRecord<CodexUpstreamState> | null
  writes: Array<{ id: string; nextState: CodexUpstreamState }> = []
  getByIdCalls = 0
  private getByIdOverrides: Array<() => Promise<UpstreamRecord<CodexUpstreamState> | null>> = []
  private saveErrorOnce: unknown = null

  constructor(row: UpstreamRecord<CodexUpstreamState> | null) {
    this.row = row
  }

  queueGetById(fn: () => Promise<UpstreamRecord<CodexUpstreamState> | null>) {
    this.getByIdOverrides.push(fn)
  }

  failNextSave(err: unknown) {
    this.saveErrorOnce = err
  }

  async getById<TState = unknown>(id: string): Promise<UpstreamRecord<TState> | null> {
    this.getByIdCalls++
    if (id !== UPSTREAM_ID) return null
    if (this.getByIdOverrides.length > 0) {
      const fn = this.getByIdOverrides.shift()!
      const r = await fn()
      return r ? (structuredClone(r) as UpstreamRecord<TState>) : null
    }
    return this.row ? (structuredClone(this.row) as UpstreamRecord<TState>) : null
  }

  async saveState<TState>(id: string, updater: (current: TState) => TState): Promise<void> {
    if (this.saveErrorOnce !== null) {
      const err = this.saveErrorOnce
      this.saveErrorOnce = null
      throw err
    }
    if (!this.row) throw new UpstreamGoneError(id)
    const before = JSON.stringify(this.row.state)
    const next = updater(structuredClone(this.row.state) as TState) as unknown as CodexUpstreamState
    const nextJson = JSON.stringify(next)
    if (nextJson === before) return
    this.row.state = next
    this.row.updatedAt = new Date().toISOString()
    this.writes.push({ id, nextState: structuredClone(next) })
  }
}

let repo: RecordingRepo

const storedState = (): CodexUpstreamState => repo.row!.state

beforeEach(() => {
  repo = new RecordingRepo(makeRecord({ accounts: [baseAccount()] }))
  initUpstreamRepo(() => repo)
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
})

afterEach(() => {
  initUpstreamRepo(() => { throw new Error('UpstreamRepo torn down') })
  __resetPlatformForTests()
})

describe('putCodexAccessToken', () => {
  test('persists the entry into the account slot, leaving the rest alone', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_new', expiresAt: FAR_FUTURE_MS, refreshedAt: '2026-06-01T00:00:00.000Z' }
    await putCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID, entry)
    expect(repo.writes.length).toBe(1)
    expect(storedState()).toEqual({ accounts: [{ ...baseAccount(), accessToken: entry }] })
  })

  test('propagates storage failures so the request path surfaces them', async () => {
    repo.failNextSave(new Error('D1 boom'))
    const entry: CodexAccessTokenEntry = { token: 'at_new', expiresAt: FAR_FUTURE_MS, refreshedAt: 'now' }
    await expect(putCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID, entry)).rejects.toThrow('D1 boom')
  })

  test('tolerates an upstream that disappeared mid-flight', async () => {
    repo.row = null
    const entry: CodexAccessTokenEntry = { token: 'at_new', expiresAt: FAR_FUTURE_MS, refreshedAt: 'now' }
    await putCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID, entry)
    expect(repo.writes).toEqual([])
  })

  test('warns and writes nothing when the requested account is not in the pool', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_new', expiresAt: FAR_FUTURE_MS, refreshedAt: 'now' }
    await putCodexAccessToken(UPSTREAM_ID, 'acc_other', entry)
    expect(repo.writes).toEqual([])
  })
})

describe('invalidateCodexAccessToken', () => {
  test('clears a populated access-token slot', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_x', expiresAt: FAR_FUTURE_MS, refreshedAt: 'now' }
    repo.row = makeRecord({ accounts: [{ ...baseAccount(), accessToken: entry }] })
    await invalidateCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID)
    expect(storedState().accounts[0]!.accessToken).toBeNull()
  })

  test('writes nothing when the slot is already null', async () => {
    await invalidateCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID)
    expect(repo.writes).toEqual([])
  })
})

describe('ensureCodexAccessToken', () => {
  test('returns the cached token when still fresh and skips mint', async () => {
    const entry: CodexAccessTokenEntry = { token: 'at_x', expiresAt: FAR_FUTURE_MS, refreshedAt: 'now' }
    repo.row = makeRecord({ accounts: [{ ...baseAccount(), accessToken: entry }] })
    const mint = mock(() => Promise.resolve(entry))
    const out = await ensureCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID, mint)
    expect(out).toEqual(entry)
    expect(mint).not.toHaveBeenCalled()
  })

  test('mints when nothing is cached, then persists', async () => {
    const minted: CodexAccessTokenEntry = { token: 'at_minted', expiresAt: FAR_FUTURE_MS, refreshedAt: 'now' }
    const mint = mock((_rt: string) => Promise.resolve(minted))
    const out = await ensureCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID, mint)
    expect(out).toEqual(minted)
    expect(mint).toHaveBeenCalledWith('rt_v1')
    expect(storedState().accounts[0]!.accessToken).toEqual(minted)
  })

  test('mints when the cached token is within the refresh skew window', async () => {
    const expiresSoon = Date.now() + 60 * 1000
    repo.row = makeRecord({
      accounts: [
        { ...baseAccount(), accessToken: { token: 'at_old', expiresAt: expiresSoon, refreshedAt: 'old' } },
      ],
    })
    const minted: CodexAccessTokenEntry = { token: 'at_minted', expiresAt: FAR_FUTURE_MS, refreshedAt: 'now' }
    const mint = mock((_rt: string) => Promise.resolve(minted))
    const out = await ensureCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID, mint)
    expect(out).toEqual(minted)
    expect(mint).toHaveBeenCalledWith('rt_v1')
  })

  test('throws when the upstream row is missing', async () => {
    repo.row = null
    const mint = mock(() => Promise.reject(new Error('should not run')))
    await expect(ensureCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID, mint)).rejects.toThrow(/not found/)
    expect(mint).not.toHaveBeenCalled()
  })

  test('throws when the requested account is not in the pool', async () => {
    const mint = mock(() => Promise.reject(new Error('should not run')))
    await expect(ensureCodexAccessToken(UPSTREAM_ID, 'acc_other', mint)).rejects.toThrow(/acc_other/)
    expect(mint).not.toHaveBeenCalled()
  })

  test('propagates mint errors without persisting', async () => {
    const mint = mock(() => Promise.reject(new Error('oauth boom')))
    await expect(ensureCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID, mint)).rejects.toThrow(/oauth boom/)
    expect(repo.writes).toEqual([])
  })

  test('invalid_grant + sibling rotation → returns sibling-minted access token, no persist', async () => {
    const siblingEntry: CodexAccessTokenEntry = { token: 'at_sibling', expiresAt: FAR_FUTURE_MS, refreshedAt: 'sibling' }
    // First getById → current row; second (recovery re-read) → sibling has
    // rotated rt + populated cached access token.
    repo.queueGetById(async () => repo.row)
    repo.queueGetById(async () => {
      repo.row = makeRecord({
        accounts: [{ ...baseAccount(), refresh_token: 'rt_v2', accessToken: siblingEntry }],
      })
      return repo.row
    })
    const mint = mock(() =>
      Promise.reject(new CodexOAuthSessionTerminatedError({ code: 'invalid_grant', message: 'replayed' })),
    )
    const out = await ensureCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID, mint)
    expect(out).toEqual(siblingEntry)
    expect(mint).toHaveBeenCalledTimes(1)
    expect(repo.writes).toEqual([])
  })

  test('invalid_grant + stored RT unchanged → rethrows for caller to flip terminal', async () => {
    const mint = mock(() =>
      Promise.reject(new CodexOAuthSessionTerminatedError({ code: 'invalid_grant', message: 'revoked' })),
    )
    await expect(ensureCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID, mint)).rejects.toBeInstanceOf(
      CodexOAuthSessionTerminatedError,
    )
    expect(mint).toHaveBeenCalledTimes(1)
    expect(repo.writes).toEqual([])
  })

  test('app_session_terminated never attempts race recovery — single getById, original rethrown', async () => {
    const mint = mock(() =>
      Promise.reject(new CodexOAuthSessionTerminatedError({ code: 'app_session_terminated', message: 'gone' })),
    )
    await expect(ensureCodexAccessToken(UPSTREAM_ID, ACCOUNT_ID, mint)).rejects.toBeInstanceOf(
      CodexOAuthSessionTerminatedError,
    )
    // Exactly one getById — no recovery re-read.
    expect(repo.getByIdCalls).toBe(1)
    expect(repo.writes).toEqual([])
  })
})
