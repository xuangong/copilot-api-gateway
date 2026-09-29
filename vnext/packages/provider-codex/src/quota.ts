// Codex quota snapshot types + header parser + repo I/O.
//
// vNext note: ported from copilot-gateway/packages/provider-codex/src/quota.ts.
// Repo access swapped from `getProviderRepo().upstreams.*` to
// `getUpstreamRepo().*` (see @vibe-core/upstream-repo, wired up in F3-prep).

import { getUpstreamRepo } from '@vibe-core/upstream-repo'
import { codexBearerEffect, ignoreGoneCodexEffect, updateCodexCredential, type CodexAccessTokenLease } from "./credential-effects"

export interface CodexQuotaSnapshot {
  observed_at: string
  active_limit?: string
  plan_type?: string

  primary_used_percent?: number
  primary_window_minutes?: number
  primary_reset_after_at?: string

  secondary_used_percent?: number
  secondary_window_minutes?: number
  secondary_reset_after_at?: string

  credits_has_credits?: boolean
  credits_balance?: number

  // Present only when this snapshot was written as a result of a 429.
  ratelimited_until?: string
}

export type CodexQuotaSnapshotMap = Record<string, CodexQuotaSnapshot>

export const CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT = 'unknown'

const isUnsafeActiveLimitKey = (key: string): boolean =>
  key === '__proto__' || key === 'constructor' || key === 'prototype'

export const codexQuotaActiveLimitKey = (snapshot: CodexQuotaSnapshot): string => {
  const key = snapshot.active_limit?.trim()
  return key && !isUnsafeActiveLimitKey(key) ? key : CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT
}

const TTL_FLOOR_MS = 24 * 60 * 60 * 1000

interface ParseCodexQuotaOptions {
  now: Date
  isRateLimited: boolean
}

export const parseCodexQuotaHeaders = (
  headers: Headers,
  options: ParseCodexQuotaOptions,
): CodexQuotaSnapshot => {
  const snapshot: CodexQuotaSnapshot = { observed_at: options.now.toISOString() }
  const assign = snapshot as unknown as Record<string, unknown>

  const setString = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header)
    if (v === null) return
    const trimmed = v.trim()
    if (trimmed !== '') assign[key] = trimmed
  }
  const setNumber = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header)
    if (v === null) return
    const n = Number(v)
    if (Number.isFinite(n)) assign[key] = n
  }
  const setBool = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header)
    if (v === null) return
    const lower = v.toLowerCase()
    if (lower === 'true') assign[key] = true
    else if (lower === 'false') assign[key] = false
  }
  const setResetAfter = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header)
    if (v === null) return
    const seconds = Number(v)
    if (!Number.isFinite(seconds)) return
    assign[key] = new Date(options.now.getTime() + seconds * 1000).toISOString()
  }

  setString('active_limit', 'x-codex-active-limit')
  setString('plan_type', 'x-codex-plan-type')
  setNumber('primary_used_percent', 'x-codex-primary-used-percent')
  setNumber('primary_window_minutes', 'x-codex-primary-window-minutes')
  setResetAfter('primary_reset_after_at', 'x-codex-primary-reset-after-seconds')
  setNumber('secondary_used_percent', 'x-codex-secondary-used-percent')
  setNumber('secondary_window_minutes', 'x-codex-secondary-window-minutes')
  setResetAfter('secondary_reset_after_at', 'x-codex-secondary-reset-after-seconds')
  setBool('credits_has_credits', 'x-codex-credits-has-credits')
  setNumber('credits_balance', 'x-codex-credits-balance')

  if (options.isRateLimited) {
    const primary = Number(headers.get('x-codex-primary-reset-after-seconds'))
    const secondary = Number(headers.get('x-codex-secondary-reset-after-seconds'))
    const seconds = Math.max(
      Number.isFinite(primary) ? primary : 0,
      Number.isFinite(secondary) ? secondary : 0,
    )
    if (seconds > 0) {
      snapshot.ratelimited_until = new Date(options.now.getTime() + seconds * 1000).toISOString()
    }
  }

  return snapshot
}

// Bound TTL by the furthest reset horizon to keep a hot account's state
// alive through its entire window; floor at 24h so dashboard reads survive
// quiet periods between bursts.
export const computeCodexQuotaTtlMs = (snapshot: CodexQuotaSnapshot, now: Date): number => {
  const horizons = [
    snapshot.primary_reset_after_at,
    snapshot.secondary_reset_after_at,
    snapshot.ratelimited_until,
  ]
    .map((s) => (s ? new Date(s).getTime() - now.getTime() : 0))
    .filter((ms) => ms > 0)
  return Math.max(TTL_FLOOR_MS, ...horizons)
}

export interface CodexQuotaObservation {
  data: CodexQuotaSnapshot
  observedAt: string
  fetchedAt: number
  freshUntil: number
  freshness: "fresh" | "stale"
}

export type CodexQuotaObservationMap = Record<string, CodexQuotaObservation>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const timestamp = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 &&
  Number.isFinite(new Date(value).getTime()) ? value : null

const isoDate = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null
  const ms = Date.parse(value)
  if (timestamp(ms) === null) return null
  const normalized = new Date(ms).toISOString()
  // Date.parse normalizes impossible calendar dates such as February 30.
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : null
}

function publicSnapshot(value: unknown): CodexQuotaSnapshot | null {
  if (!isRecord(value)) return null
  const observedAt = isoDate(value.observed_at)
  if (!observedAt) return null
  const data: CodexQuotaSnapshot = { observed_at: observedAt }
  for (const key of ["active_limit", "plan_type"] as const) {
    const field = value[key]
    if (typeof field === "string" && field.trim() && field.length <= 128) data[key] = field.trim()
  }
  for (const key of ["primary_used_percent", "secondary_used_percent", "primary_window_minutes", "secondary_window_minutes", "credits_balance"] as const) {
    const field = value[key]
    if (typeof field === "number" && Number.isFinite(field) && field >= 0) data[key] = field
  }
  for (const key of ["primary_reset_after_at", "secondary_reset_after_at", "ratelimited_until"] as const) {
    const field = isoDate(value[key])
    if (field) data[key] = field
  }
  if (typeof value.credits_has_credits === "boolean") data.credits_has_credits = value.credits_has_credits
  return data
}

// Project the already-authorized row without loading credentials, renewing a
// token, or rereading a possibly replaced row. Malformed buckets are isolated.
export function readCodexQuotaObservations(
  rawState: unknown,
  accountId: string,
  now = Date.now(),
): CodexQuotaObservationMap | null {
  if (!isRecord(rawState) || !Array.isArray(rawState.accounts) || rawState.accounts.length !== 1) return null
  const account: unknown = rawState.accounts[0]
  if (!isRecord(account) || account.chatgptAccountId !== accountId || !isRecord(account.quotaSnapshot)) return null
  const observations: CodexQuotaObservationMap = {}
  for (const [key, entry] of Object.entries(account.quotaSnapshot)) {
    if (!key.trim() || key.length > 128 || isUnsafeActiveLimitKey(key) || !isRecord(entry)) continue
    const fetchedAt = timestamp(entry.fetchedAt)
    const data = publicSnapshot(entry.data)
    if (fetchedAt === null || !data) continue
    // Anchor to receipt time, never the time at which the dashboard is opened.
    const freshUntil = fetchedAt + computeCodexQuotaTtlMs(data, new Date(fetchedAt))
    if (timestamp(freshUntil) === null) continue
    observations[key] = { data, observedAt: data.observed_at, fetchedAt, freshUntil,
      freshness: now < freshUntil ? "fresh" : "stale" }
  }
  return Object.keys(observations).length ? observations : null
}

export const getCodexQuota = async (
  upstreamId: string,
  accountId: string,
): Promise<CodexQuotaObservationMap | null> => {
  const row = await getUpstreamRepo().getById(upstreamId)
  return row?.provider === "codex" ? readCodexQuotaObservations(row.state, accountId) : null
}

export const putCodexQuota = async (
  lease: CodexAccessTokenLease,
  snapshot: CodexQuotaSnapshot,
): Promise<void> => {
  const fetchedAt = Date.now()
  await ignoreGoneCodexEffect(updateCodexCredential(codexBearerEffect(lease), account => ({
    ...account,
    quotaSnapshot: {
      ...(account.quotaSnapshot ?? {}),
      [codexQuotaActiveLimitKey(snapshot)]: { fetchedAt, data: snapshot },
    },
  })))
}
