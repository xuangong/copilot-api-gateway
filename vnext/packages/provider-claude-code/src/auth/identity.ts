import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { CLAUDE_CODE_PROFILE_URL } from '../constants'
import { logWarn } from '../log'
import { directFetcher, type Fetcher } from '../fetcher'

// Identity derived from `GET /api/oauth/profile` plus the optional CLI
// `subscriptionType` field. Anthropic returns nested `account.uuid` /
// `organization.uuid`; we flatten at the boundary so the rest of the package
// never re-handles the wire shape.
//
// `email` is nullable because Anthropic only exposes it to tokens carrying
// the `user:profile` scope. Inference-only tokens get 403 and we fall back
// to a degraded identity rather than refusing to import.
export interface ClaudeCodeIdentity {
  email: string | null
  accountUuid: string
  organizationUuid: string | null
  subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null
  rateLimitTier: string | null
}

export const fetchClaudeCodeIdentity = async (
  accessToken: string,
  fetcher: Fetcher = directFetcher,
): Promise<ClaudeCodeIdentity> => {
  const response = await fetcher(CLAUDE_CODE_PROFILE_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  })

  const rawText = await response.text()
  let parsed: unknown
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : null
  } catch (cause) {
    throw new Error(
      `Claude Code /api/oauth/profile returned non-JSON body (${response.status})`,
      { cause: cause as Error },
    )
  }

  // 403 with a `permission_error` body means the token was minted without
  // the `user:profile` scope. Fall back to a degraded identity so ingestion
  // succeeds for inference-only tokens.
  let parsedError: Record<string, unknown> | null = null
  if (typeof parsed === 'object' && parsed !== null) {
    const errorField = (parsed as Record<string, unknown>).error
    if (typeof errorField === 'object' && errorField !== null) {
      parsedError = errorField as Record<string, unknown>
    }
  }
  if (response.status === 403 && parsedError?.type === 'permission_error') {
    const accountUuid = deriveDegradedAccountUuid(accessToken)
    logWarn('claude_code_identity_degraded_fallback', {
      account_uuid: accountUuid,
      reason: 'profile_403_missing_user_profile_scope',
    })
    return {
      email: null,
      accountUuid,
      organizationUuid: null,
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  if (!response.ok) {
    const message =
      parsedError !== null && typeof parsedError.message === 'string'
        ? parsedError.message
        : null
    throw new Error(
      `Claude Code /api/oauth/profile returned ${response.status}: ${message ?? rawText.slice(0, 256)}`,
    )
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Claude Code /api/oauth/profile response is not an object')
  }
  const root = parsed as Record<string, unknown>
  const account = root.account
  if (typeof account !== 'object' || account === null) {
    throw new Error('Claude Code /api/oauth/profile response missing `account`')
  }
  const accountObj = account as Record<string, unknown>
  const accountUuid = accountObj.uuid
  const email = accountObj.email
  if (typeof accountUuid !== 'string' || accountUuid === '') {
    throw new Error('Claude Code /api/oauth/profile response missing `account.uuid`')
  }
  if (typeof email !== 'string' || email === '') {
    throw new Error('Claude Code /api/oauth/profile response missing `account.email`')
  }

  let organizationUuid: string | null = null
  let organizationType: string | null = null
  let rateLimitTier: string | null = null
  const organization = root.organization
  if (typeof organization === 'object' && organization !== null) {
    const orgObj = organization as Record<string, unknown>
    if (typeof orgObj.uuid === 'string' && orgObj.uuid !== '') {
      organizationUuid = orgObj.uuid
    }
    if (typeof orgObj.organization_type === 'string' && orgObj.organization_type !== '') {
      organizationType = orgObj.organization_type
    }
    if (typeof orgObj.rate_limit_tier === 'string' && orgObj.rate_limit_tier !== '') {
      rateLimitTier = orgObj.rate_limit_tier
    }
  }

  return {
    email,
    accountUuid,
    organizationUuid,
    subscriptionType: deriveSubscriptionType(organizationType),
    rateLimitTier,
  }
}

// Format sha256(accessToken)[0..32] as 8-4-4-4-12 so the degraded id sorts
// and displays like a real Anthropic account UUID. Not a real UUID v4 —
// purely a local dedup key; upstream never sees it.
const deriveDegradedAccountUuid = (accessToken: string): string => {
  const hex = bytesToHex(sha256(new TextEncoder().encode(accessToken))).slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// Maps `organization_type` to the CLI-canonical plan name.
//   claude_max → 'max'    claude_pro → 'pro'
//   claude_team → 'team'  claude_enterprise → 'enterprise'
// Personal accounts (no organization block) → null. Unrecognized types →
// null with a warning log so new Anthropic tiers do not break ingest.
const deriveSubscriptionType = (
  organizationType: string | null,
): 'pro' | 'max' | 'team' | 'enterprise' | null => {
  if (organizationType === null) return null
  if (organizationType === 'claude_max') return 'max'
  if (organizationType === 'claude_pro') return 'pro'
  if (organizationType === 'claude_enterprise') return 'enterprise'
  if (organizationType === 'claude_team') return 'team'
  logWarn('claude_code_unknown_organization_type', {
    organization_type: organizationType,
  })
  return null
}
