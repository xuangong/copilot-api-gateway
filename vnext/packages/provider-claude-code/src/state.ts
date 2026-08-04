// Gateway-managed Claude Code credential state, persisted in
// upstreams.state_json. Writes happen via UpstreamRepo.saveState.
//
// Two credential kinds share this shape, discriminated by `tokenKind`:
//
// - `oauth`: a short-lived access token plus a rotating refresh token.
// - `setup-token`: a long-lived (~1 year) inference-only bearer with NO
//   refresh token. When it expires the operator must re-import.

import { assertClaudeCodeQuotaSnapshot, type ClaudeCodeQuotaSnapshot } from './quota'

export interface ClaudeCodeAccessTokenEntry {
  token: string
  expiresAt: number
  refreshedAt: string
}

export interface ClaudeCodeQuotaSnapshotEntry {
  fetchedAt: number
  data: ClaudeCodeQuotaSnapshot
}

export interface ClaudeCodeUsageProbeSnapshotEntry {
  fetchedAt: number
  data: unknown
}

export type ClaudeCodeAccountCredential = ClaudeCodeAccountCredentialBase &
  ClaudeCodeAccountCredentialTokenKind &
  ClaudeCodeAccountCredentialHealth

interface ClaudeCodeAccountCredentialBase {
  accountUuid: string
  stateUpdatedAt: string
  accessToken: ClaudeCodeAccessTokenEntry | null
  quotaSnapshot: ClaudeCodeQuotaSnapshotEntry | null
  usageProbeSnapshot: ClaudeCodeUsageProbeSnapshotEntry | null
}

type ClaudeCodeAccountCredentialTokenKind =
  | { tokenKind: 'oauth'; refreshToken: string }
  | { tokenKind: 'setup-token'; refreshToken: null }

type ClaudeCodeAccountCredentialHealth =
  | { state: 'active'; stateMessage?: undefined }
  | { state: 'session_terminated' | 'refresh_failed'; stateMessage: string }

export interface ClaudeCodeUpstreamState {
  accounts: ClaudeCodeAccountCredential[]
}

const assertOnlyKeys = (
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void => {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`${where} has unexpected key '${key}'`)
    }
  }
}

const ACCESS_TOKEN_KEYS = ['token', 'expiresAt', 'refreshedAt'] as const
const QUOTA_SNAPSHOT_KEYS = ['fetchedAt', 'data'] as const
const USAGE_PROBE_SNAPSHOT_KEYS = ['fetchedAt', 'data'] as const
const CREDENTIAL_KEYS = [
  'accountUuid',
  'tokenKind',
  'refreshToken',
  'state',
  'stateMessage',
  'stateUpdatedAt',
  'accessToken',
  'quotaSnapshot',
  'usageProbeSnapshot',
] as const
const STATE_KEYS = ['accounts'] as const

const assertClaudeCodeAccessTokenEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`)
  }
  const obj = value as Record<string, unknown>
  assertOnlyKeys(obj, ACCESS_TOKEN_KEYS, where)
  if (typeof obj.token !== 'string' || obj.token === '') {
    throw new TypeError(`${where}.token must be a non-empty string`)
  }
  if (typeof obj.expiresAt !== 'number' || !Number.isFinite(obj.expiresAt)) {
    throw new TypeError(`${where}.expiresAt must be a finite number`)
  }
  if (typeof obj.refreshedAt !== 'string' || obj.refreshedAt === '') {
    throw new TypeError(`${where}.refreshedAt must be a non-empty string`)
  }
}

const assertClaudeCodeQuotaSnapshotEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`)
  }
  const obj = value as Record<string, unknown>
  assertOnlyKeys(obj, QUOTA_SNAPSHOT_KEYS, where)
  if (typeof obj.fetchedAt !== 'number' || !Number.isFinite(obj.fetchedAt)) {
    throw new TypeError(`${where}.fetchedAt must be a finite number`)
  }
  assertClaudeCodeQuotaSnapshot(obj.data, `${where}.data`)
}

const assertClaudeCodeUsageProbeSnapshotEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`)
  }
  const obj = value as Record<string, unknown>
  assertOnlyKeys(obj, USAGE_PROBE_SNAPSHOT_KEYS, where)
  if (typeof obj.fetchedAt !== 'number' || !Number.isFinite(obj.fetchedAt)) {
    throw new TypeError(`${where}.fetchedAt must be a finite number`)
  }
  if (typeof obj.data !== 'object' || obj.data === null || Array.isArray(obj.data)) {
    throw new TypeError(`${where}.data must be a plain object`)
  }
}

const assertClaudeCodeAccountCredential = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`)
  }
  const obj = value as Record<string, unknown>
  assertOnlyKeys(obj, CREDENTIAL_KEYS, where)
  if (typeof obj.accountUuid !== 'string' || obj.accountUuid === '') {
    throw new TypeError(`${where}.accountUuid must be a non-empty string`)
  }
  if (obj.tokenKind !== 'oauth' && obj.tokenKind !== 'setup-token') {
    throw new TypeError(
      `${where}.tokenKind must be one of 'oauth' | 'setup-token', got ${String(obj.tokenKind)}`,
    )
  }
  if (obj.tokenKind === 'setup-token') {
    if (obj.refreshToken !== null) {
      throw new TypeError(`${where}.refreshToken must be null for setup-token`)
    }
  } else if (typeof obj.refreshToken !== 'string' || obj.refreshToken === '') {
    throw new TypeError(`${where}.refreshToken must be a non-empty string for oauth`)
  }
  if (
    obj.state !== 'active' &&
    obj.state !== 'session_terminated' &&
    obj.state !== 'refresh_failed'
  ) {
    throw new TypeError(
      `${where}.state must be one of 'active' | 'session_terminated' | 'refresh_failed', got ${String(obj.state)}`,
    )
  }
  if (obj.state === 'active') {
    if (obj.stateMessage !== undefined) {
      throw new TypeError(`${where}.stateMessage must be absent on active state`)
    }
  } else if (typeof obj.stateMessage !== 'string' || obj.stateMessage === '') {
    throw new TypeError(`${where}.stateMessage must be a non-empty string on terminal state`)
  }
  if (typeof obj.stateUpdatedAt !== 'string' || obj.stateUpdatedAt === '') {
    throw new TypeError(`${where}.stateUpdatedAt must be a non-empty ISO string`)
  }
  if (obj.accessToken !== null) {
    assertClaudeCodeAccessTokenEntry(obj.accessToken, `${where}.accessToken`)
  }
  if (obj.quotaSnapshot !== null) {
    assertClaudeCodeQuotaSnapshotEntry(obj.quotaSnapshot, `${where}.quotaSnapshot`)
  }
  if (obj.usageProbeSnapshot !== null) {
    assertClaudeCodeUsageProbeSnapshotEntry(
      obj.usageProbeSnapshot,
      `${where}.usageProbeSnapshot`,
    )
  }
}

export function assertClaudeCodeUpstreamState(
  value: unknown,
): asserts value is ClaudeCodeUpstreamState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ClaudeCodeUpstreamState must be a plain object')
  }
  const obj = value as Record<string, unknown>
  assertOnlyKeys(obj, STATE_KEYS, 'ClaudeCodeUpstreamState')
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('ClaudeCodeUpstreamState.accounts must be an array')
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(
      `ClaudeCodeUpstreamState.accounts must hold exactly one account (got ${obj.accounts.length})`,
    )
  }
  for (let i = 0; i < obj.accounts.length; i++) {
    assertClaudeCodeAccountCredential(
      obj.accounts[i],
      `ClaudeCodeUpstreamState.accounts[${i}]`,
    )
  }
}

export const readClaudeCodeUpstreamState = (raw: unknown): ClaudeCodeUpstreamState => {
  assertClaudeCodeUpstreamState(raw)
  return raw
}

export const replaceSoleAccount = (
  state: ClaudeCodeUpstreamState,
  patch: (account: ClaudeCodeAccountCredential) => ClaudeCodeAccountCredential,
): ClaudeCodeUpstreamState => ({
  ...state,
  accounts: [patch(state.accounts[0]!)],
})
