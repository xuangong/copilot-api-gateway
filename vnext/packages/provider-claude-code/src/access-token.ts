// Claude Code OAuth access-token lifecycle: mint / cache / invalidate /
// refresh-race recovery, plus setup-token short-circuit. Ported from
// copilot-gateway/packages/provider-claude-code/src/access-token.ts.
//
// vNext adaptations:
//   - Repo access swapped to `@vibe-core/upstream-repo` (getUpstreamRepo).
//   - `UpstreamGoneError` imported from `@vibe-core/upstream-repo`.
//   - `Fetcher` imported from local ./fetcher.
//   - No semicolons per vNext lint config.

import { getUpstreamRepo, UpstreamGoneError } from '@vibe-core/upstream-repo'
import {
  ClaudeCodeOAuthSessionTerminatedError,
  refreshClaudeCodeAccessToken,
} from './auth/oauth'
import type { Fetcher } from './fetcher'
import { logInfo, logWarn } from './log'
import {
  readClaudeCodeUpstreamState,
  replaceSoleAccount,
  type ClaudeCodeAccessTokenEntry,
  type ClaudeCodeAccountCredential,
  type ClaudeCodeUpstreamState,
} from './state'

export type { ClaudeCodeAccessTokenEntry }

// `freshlyMinted` is true when this call site shared in a real
// /v1/oauth/token round-trip (drove the mint itself or coalesced onto an
// in-flight mint). False when a cached entry was returned. The 401-retry
// path uses this to decide whether a 401 means the cached token is stale
// (invalidate + retry) or that the credential is dead (surface the 401).
export interface EnsuredAccessToken {
  entry: ClaudeCodeAccessTokenEntry
  freshlyMinted: boolean
}

const REFRESH_SKEW_MS = 5 * 60 * 1000

const isAccessTokenFresh = (entry: ClaudeCodeAccessTokenEntry): boolean =>
  entry.expiresAt > Date.now() + REFRESH_SKEW_MS

export interface EnsureClaudeCodeAccessTokenArgs {
  upstreamId: string
  fetcher: Fetcher
  // When true, skip the "cached access_token is still fresh" fast-path and
  // always call the OAuth refresh endpoint. Dashboard Refresh sets this;
  // data plane leaves it false. Coalescing keys on (upstreamId, force).
  force?: boolean
}

// Process-local coalescing of concurrent ensure calls. Cross-isolate
// siblings still race and are caught by `recoverFromRefreshRace`.
const inFlightEnsures = new Map<string, Promise<EnsuredAccessToken>>()

export const ensureClaudeCodeAccessToken = async (
  args: EnsureClaudeCodeAccessTokenArgs,
): Promise<EnsuredAccessToken> => {
  const key = `${args.upstreamId}:${args.force ? 'force' : 'lazy'}`
  const existing = inFlightEnsures.get(key)
  if (existing) return await existing
  const promise = ensureClaudeCodeAccessTokenInner(args, true)
  inFlightEnsures.set(key, promise)
  try {
    return await promise
  } finally {
    inFlightEnsures.delete(key)
  }
}

const ensureClaudeCodeAccessTokenInner = async (
  args: EnsureClaudeCodeAccessTokenArgs,
  recoveryAllowed: boolean,
): Promise<EnsuredAccessToken> => {
  const fresh = await getUpstreamRepo().getById(args.upstreamId)
  if (!fresh) throw new Error(`Claude Code upstream ${args.upstreamId} not found`)
  const state = readClaudeCodeUpstreamState(fresh.state)

  const account = state.accounts[0]!
  if (account.state !== 'active') {
    throw new ClaudeCodeOAuthSessionTerminatedError({
      code: account.state,
      message: account.stateMessage,
    })
  }

  // Setup-token: the cached access token IS the credential — there is no
  // refresh counterpart. Fresh → return it. Expired → flip to terminal;
  // the operator must re-import. The 1-year validity makes expiry rare.
  if (account.tokenKind === 'setup-token') {
    if (account.accessToken && isAccessTokenFresh(account.accessToken)) {
      return { entry: account.accessToken, freshlyMinted: false }
    }
    const message = 'Setup token expired or absent; re-import to recover'
    await persistTerminalState(args.upstreamId, account, {
      reason: 'setup_token_expired',
      message,
      oauthCode: null,
    })
    throw new ClaudeCodeOAuthSessionTerminatedError({ code: 'setup_token_expired', message })
  }

  if (account.accessToken && isAccessTokenFresh(account.accessToken) && !args.force) {
    return { entry: account.accessToken, freshlyMinted: false }
  }

  let refreshed
  try {
    refreshed = await refreshClaudeCodeAccessToken(account.refreshToken, args.fetcher)
  } catch (error) {
    if (error instanceof ClaudeCodeOAuthSessionTerminatedError) {
      if (error.code === 'invalid_grant' && recoveryAllowed) {
        const recovered = await recoverFromRefreshRace(args, account.refreshToken)
        if (recovered) return recovered
      }
      await persistTerminalState(args.upstreamId, account, {
        reason: 'oauth_refresh_failed',
        message: error.upstreamMessage,
        oauthCode: error.code,
      })
    }
    throw error
  }

  const now = new Date().toISOString()
  const newAccessTokenEntry: ClaudeCodeAccessTokenEntry = {
    token: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    refreshedAt: now,
  }

  // Refresh-token rotation: the new refresh token and the fresh access-token
  // entry land in one state transition. `state` / `stateUpdatedAt` stay
  // untouched on a successful refresh — 'active' is already what we want.
  // A re-import that swapped the credential class in the meantime leaves
  // nothing to rotate — the account is returned untouched.
  const rotatedRefreshToken = refreshed.refresh_token
  if (typeof rotatedRefreshToken !== 'string' || rotatedRefreshToken === '') {
    throw new Error('Claude Code refresh response missing refresh_token')
  }
  try {
    await getUpstreamRepo().saveState<ClaudeCodeUpstreamState>(args.upstreamId, (current) =>
      replaceSoleAccount(readClaudeCodeUpstreamState(current), (stored) =>
        stored.tokenKind === 'oauth'
          ? { ...stored, refreshToken: rotatedRefreshToken, accessToken: newAccessTokenEntry }
          : stored,
      ),
    )
  } catch (err) {
    // Operator deleted the upstream mid-request — the minted token is
    // bookkeeping the next request re-derives, so don't fail this one.
    if (!(err instanceof UpstreamGoneError)) throw err
    logWarn('claude_code_upstream_gone_mid_refresh', { upstream_id: args.upstreamId })
  }
  logInfo('claude_code_refresh_token_rotated', {
    upstream_id: args.upstreamId,
    account_uuid: account.accountUuid,
    expires_in_seconds: refreshed.expires_in,
    refreshed_at: now,
  })
  return { entry: newAccessTokenEntry, freshlyMinted: true }
}

const persistTerminalState = async (
  upstreamId: string,
  previousAccount: ClaudeCodeAccountCredential,
  fields: {
    reason: string
    message: string
    // Raw OAuth `error` code (e.g. `invalid_grant`, `app_session_terminated`)
    // when triggered by an upstream OAuth response; `null` for code-internal
    // flips (e.g. setup-token expiry).
    oauthCode: string | null
  },
): Promise<void> => {
  // Stamped before the write: the mutator may be replayed on a lost race and
  // must return the same document each time.
  const flippedAt = new Date().toISOString()
  try {
    await getUpstreamRepo().saveState<ClaudeCodeUpstreamState>(upstreamId, (current) =>
      replaceSoleAccount(readClaudeCodeUpstreamState(current), (account) => ({
        ...account,
        state: 'refresh_failed',
        stateMessage: fields.message,
        stateUpdatedAt: flippedAt,
        accessToken: null,
      })),
    )
  } catch (err) {
    if (!(err instanceof UpstreamGoneError)) throw err
    logWarn('claude_code_upstream_gone_mid_terminal_flip', { upstream_id: upstreamId })
    return
  }
  logWarn('claude_code_account_state_flip', {
    upstream_id: upstreamId,
    account_uuid: previousAccount.accountUuid,
    from_state: previousAccount.state,
    to_state: 'refresh_failed',
    reason: fields.reason,
    oauth_code: fields.oauthCode,
    message: fields.message,
  })
}

// `invalid_grant` ambiguity: dead refresh token, or a sibling worker raced us
// and we hold the rotated-out copy. Re-read state and compare. Depth guard
// prevents runaway recursion if recovery itself observes a stale view.
// Returns `null` when the original error should surface.
const recoverFromRefreshRace = async (
  args: EnsureClaudeCodeAccessTokenArgs,
  usedRefreshToken: string,
): Promise<EnsuredAccessToken | null> => {
  const reread = await getUpstreamRepo().getById(args.upstreamId)
  if (!reread) return null
  const rereadState = readClaudeCodeUpstreamState(reread.state)
  const rereadAccount = rereadState.accounts[0]!
  if (rereadAccount.state !== 'active') return null
  // Setup-token doesn't reach this path under normal flow; if a concurrent
  // re-import flipped credential class between our refresh and re-read, give
  // up and let the original error surface.
  if (rereadAccount.tokenKind === 'setup-token') return null
  if (rereadAccount.refreshToken === usedRefreshToken) return null
  logInfo('claude_code_refresh_race_recovered', {
    upstream_id: args.upstreamId,
    account_uuid: rereadAccount.accountUuid,
    rotated_refresh_token_prefix: rereadAccount.refreshToken.slice(0, 6),
  })
  if (rereadAccount.accessToken && isAccessTokenFresh(rereadAccount.accessToken)) {
    return { entry: rereadAccount.accessToken, freshlyMinted: false }
  }
  // Sibling rotated the refresh token but no usable access token sits in
  // state (concurrent `invalidateClaudeCodeAccessToken` cleared it).
  // Re-enter once with the live RT; depth guard suppresses a second recovery.
  return await ensureClaudeCodeAccessTokenInner(args, false)
}

// Used in 401-retry: clear the cached access token without touching the
// refresh token, so the next call mints a fresh one.
export const invalidateClaudeCodeAccessToken = async (upstreamId: string): Promise<void> => {
  try {
    await getUpstreamRepo().saveState<ClaudeCodeUpstreamState>(upstreamId, (current) => {
      const state = readClaudeCodeUpstreamState(current)
      if (state.accounts[0]!.accessToken === null) return state
      return replaceSoleAccount(state, (account) => ({ ...account, accessToken: null }))
    })
  } catch (err) {
    if (!(err instanceof UpstreamGoneError)) throw err
    logWarn('claude_code_upstream_gone_mid_invalidate', { upstream_id: upstreamId })
  }
}
