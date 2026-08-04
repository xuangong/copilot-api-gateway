import type { ClaudeCodeUpstreamConfig } from '../config'
import type { ClaudeCodeAccountCredential, ClaudeCodeUpstreamState } from '../state'
import { fetchClaudeCodeIdentity, type ClaudeCodeIdentity } from './identity'
import { exchangeClaudeCodeAuthorizationCode } from './oauth'
import { directFetcher, type Fetcher } from '../fetcher'

export interface ClaudeCodeImportResult {
  config: ClaudeCodeUpstreamConfig
  state: ClaudeCodeUpstreamState
}

type BuildImportResultParams = {
  identity: ClaudeCodeIdentity
  accessToken: string
  expiresAt: number
  now: string
} & ({ tokenKind: 'setup-token' } | { tokenKind: 'oauth'; refreshToken: string })

const buildClaudeCodeImportResult = (params: BuildImportResultParams): ClaudeCodeImportResult => {
  const accessTokenEntry = {
    token: params.accessToken,
    expiresAt: params.expiresAt,
    refreshedAt: params.now,
  }
  const credentialBase = {
    accountUuid: params.identity.accountUuid,
    state: 'active' as const,
    stateUpdatedAt: params.now,
    accessToken: accessTokenEntry,
    quotaSnapshot: null,
    usageProbeSnapshot: null,
  }
  const credential: ClaudeCodeAccountCredential =
    params.tokenKind === 'setup-token'
      ? { ...credentialBase, tokenKind: 'setup-token', refreshToken: null }
      : { ...credentialBase, tokenKind: 'oauth', refreshToken: params.refreshToken }
  return {
    config: {
      accounts: [
        {
          email: params.identity.email,
          accountUuid: params.identity.accountUuid,
          organizationUuid: params.identity.organizationUuid,
          subscriptionType: params.identity.subscriptionType,
          rateLimitTier: params.identity.rateLimitTier,
        },
      ],
    },
    state: { accounts: [credential] },
  }
}

// Full OAuth flow import: PKCE callback → three-scope grant → profile lookup.
// `fetcher` is caller-supplied because the upstream record does not exist yet
// (proxy fallback chain lives on the persisted record). Pass `directFetcher`
// for direct egress.
export const importClaudeCodeFromCallback = async (opts: {
  code: string
  pkceVerifier: string
  state: string
  fetcher: Fetcher
}): Promise<ClaudeCodeImportResult> => {
  const tokens = await exchangeClaudeCodeAuthorizationCode({
    code: opts.code,
    codeVerifier: opts.pkceVerifier,
    state: opts.state,
    kind: 'oauth',
    fetcher: opts.fetcher,
  })
  if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token === '') {
    throw new Error(
      'Claude Code OAuth /token response missing refresh_token on full-scope exchange',
    )
  }
  const identity = await fetchClaudeCodeIdentity(tokens.access_token, opts.fetcher)
  return buildClaudeCodeImportResult({
    identity,
    tokenKind: 'oauth',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    now: new Date().toISOString(),
  })
}

// Setup-Token PKCE flow. Authorize URL carried only `user:inference`; the
// exchange asks for a ~1 year access token with no refresh_token — when it
// expires the operator must re-import. Since the bearer lacks `user:profile`,
// `fetchClaudeCodeIdentity` falls back to a degraded identity.
export const importClaudeCodeFromSetupTokenCallback = async (opts: {
  code: string
  pkceVerifier: string
  state: string
  fetcher: Fetcher
}): Promise<ClaudeCodeImportResult> => {
  const tokens = await exchangeClaudeCodeAuthorizationCode({
    code: opts.code,
    codeVerifier: opts.pkceVerifier,
    state: opts.state,
    kind: 'setup-token',
    fetcher: opts.fetcher,
  })
  const identity = await fetchClaudeCodeIdentity(tokens.access_token, opts.fetcher)
  return buildClaudeCodeImportResult({
    identity,
    tokenKind: 'setup-token',
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    now: new Date().toISOString(),
  })
}

const pickNonEmptyString = (
  record: Record<string, unknown>,
  key: string,
  prefix: string,
): string => {
  const value = record[key]
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${prefix}.${key} must be a non-empty string`)
  }
  return value
}

// Verbatim ~/.claude/.credentials.json paste. CLI on-disk format wraps tokens
// under `.claudeAiOauth` and stores `subscriptionType` + `rateLimitTier` as
// sibling fields. The JSON lacks email / account uuid so we still call
// /api/oauth/profile, but honor the two persisted plan fields verbatim when
// present (avoids derivation drift). The JSON's `accessToken` is reused so
// the first request does not need a refresh round-trip.
export const importClaudeCodeFromCredentialsJson = async (
  rawJson: string,
  fetcher: Fetcher = directFetcher,
): Promise<ClaudeCodeImportResult> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (cause) {
    throw new Error('credentials.json is not valid JSON', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('credentials.json must be a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  const wrapper = obj.claudeAiOauth
  if (typeof wrapper !== 'object' || wrapper === null || Array.isArray(wrapper)) {
    throw new TypeError('credentials.json missing `claudeAiOauth` object')
  }
  const w = wrapper as Record<string, unknown>

  const accessToken = pickNonEmptyString(w, 'accessToken', 'credentials.json.claudeAiOauth')
  const refreshToken = pickNonEmptyString(w, 'refreshToken', 'credentials.json.claudeAiOauth')
  const expiresAtRaw = w.expiresAt
  if (typeof expiresAtRaw !== 'number' || !Number.isFinite(expiresAtRaw)) {
    throw new TypeError(
      'credentials.json.claudeAiOauth.expiresAt must be a finite number (unix ms)',
    )
  }
  // Reject too-small values (1e12 ≈ 2001-09-09) to catch a seconds-encoded regression.
  if (expiresAtRaw < 1_000_000_000_000) {
    throw new TypeError(
      'credentials.json.claudeAiOauth.expiresAt looks like seconds, expected milliseconds',
    )
  }

  const persistedSubscriptionType =
    w.subscriptionType === 'pro' ||
    w.subscriptionType === 'max' ||
    w.subscriptionType === 'team' ||
    w.subscriptionType === 'enterprise'
      ? w.subscriptionType
      : null
  const persistedRateLimitTier =
    typeof w.rateLimitTier === 'string' && w.rateLimitTier !== '' ? w.rateLimitTier : null

  const identity = await fetchClaudeCodeIdentity(accessToken, fetcher)
  const finalIdentity: ClaudeCodeIdentity = {
    ...identity,
    ...(persistedSubscriptionType !== null ? { subscriptionType: persistedSubscriptionType } : {}),
    ...(persistedRateLimitTier !== null ? { rateLimitTier: persistedRateLimitTier } : {}),
  }

  return buildClaudeCodeImportResult({
    identity: finalIdentity,
    tokenKind: 'oauth',
    accessToken,
    refreshToken,
    expiresAt: expiresAtRaw,
    now: new Date().toISOString(),
  })
}
