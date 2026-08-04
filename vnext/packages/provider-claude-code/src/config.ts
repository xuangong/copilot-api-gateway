import type { UpstreamRecord } from '@vibe-llm/protocols/common'
import type { ClaudeCodeUpstreamState } from './state'

// One Claude account's operator-managed identity, derived from /v1/oauth/profile
// at import time. Mutating credentials (refreshToken, accessToken, credential
// health) live in ClaudeCodeUpstreamState instead.
export interface ClaudeCodeAccountIdentity {
  // null when the OAuth token lacks `user:profile` scope (the profile
  // endpoint returns 403 and we fall back to a degraded identity).
  email: string | null
  accountUuid: string
  // Anthropic returns null for personal accounts and a UUID for team / org-tier
  // members. Nullable distinguishes "upstream said null" from "absent".
  organizationUuid: string | null
  // CLI-canonical plan name from `organization.organization_type`. Null for
  // personal accounts / unrecognized organization_type. Mirrors the official
  // CLI's persisted `subscriptionType` field in ~/.claude/.credentials.json.
  subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null
  // Raw `organization.rate_limit_tier` passed through verbatim (e.g.
  // 'default_claude_max_5x'). Null for personal accounts / 403-fallback path.
  // Not enum-cast so new Anthropic tiers do not break ingest.
  rateLimitTier: string | null
}

// Account pool. v1 always carries exactly one entry — typed as a 1-tuple so
// callers can index accounts[0] without a nullable cushion.
export interface ClaudeCodeUpstreamConfig {
  accounts: [ClaudeCodeAccountIdentity]
}

export type ClaudeCodeUpstreamRecord = UpstreamRecord<ClaudeCodeUpstreamState> & {
  provider: 'claude-code'
  config: ClaudeCodeUpstreamConfig
}

const IDENTITY_KEYS = [
  'email',
  'accountUuid',
  'organizationUuid',
  'subscriptionType',
  'rateLimitTier',
] as const

function assertClaudeCodeAccountIdentity(
  value: unknown,
  where: string,
): asserts value is ClaudeCodeAccountIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`)
  }
  const obj = value as Record<string, unknown>
  const allowed = new Set<string>(IDENTITY_KEYS)
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${where} has unexpected key '${key}'`)
    }
  }
  if (obj.email !== null && (typeof obj.email !== 'string' || obj.email === '')) {
    throw new TypeError(`${where}.email must be null or a non-empty string`)
  }
  if (typeof obj.accountUuid !== 'string' || obj.accountUuid === '') {
    throw new TypeError(`${where}.accountUuid must be a non-empty string`)
  }
  if (
    obj.organizationUuid !== null &&
    (typeof obj.organizationUuid !== 'string' || obj.organizationUuid === '')
  ) {
    throw new TypeError(`${where}.organizationUuid must be null or a non-empty string`)
  }
  if (
    obj.subscriptionType !== null &&
    obj.subscriptionType !== 'pro' &&
    obj.subscriptionType !== 'max' &&
    obj.subscriptionType !== 'team' &&
    obj.subscriptionType !== 'enterprise'
  ) {
    throw new TypeError(
      `${where}.subscriptionType must be null or one of 'pro' | 'max' | 'team' | 'enterprise', got ${String(obj.subscriptionType)}`,
    )
  }
  if (
    obj.rateLimitTier !== null &&
    (typeof obj.rateLimitTier !== 'string' || obj.rateLimitTier === '')
  ) {
    throw new TypeError(`${where}.rateLimitTier must be null or a non-empty string`)
  }
}

function assertClaudeCodeUpstreamConfig(value: unknown): asserts value is ClaudeCodeUpstreamConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ClaudeCodeUpstreamConfig must be a plain object')
  }
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (key !== 'accounts') {
      throw new TypeError(`ClaudeCodeUpstreamConfig has unexpected key '${key}'`)
    }
  }
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('ClaudeCodeUpstreamConfig.accounts must be an array')
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(
      `ClaudeCodeUpstreamConfig.accounts must hold exactly one account (got ${obj.accounts.length})`,
    )
  }
  assertClaudeCodeAccountIdentity(obj.accounts[0], 'ClaudeCodeUpstreamConfig.accounts[0]')
}

export function assertClaudeCodeUpstreamRecord(
  record: UpstreamRecord<unknown>,
): asserts record is ClaudeCodeUpstreamRecord {
  if (record.provider !== 'claude-code') {
    throw new TypeError(`Expected provider 'claude-code', got '${record.provider}'`)
  }
  assertClaudeCodeUpstreamConfig(record.config)
}
