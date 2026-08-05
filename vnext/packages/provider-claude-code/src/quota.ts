// `anthropic-ratelimit-unified-*` types + assertion helpers + persist helpers.
// Ported in Ga; parser + type shape landed in G0-prep.

import { getUpstreamRepo } from '@vibe-core/upstream-repo'
import {
  readClaudeCodeUpstreamState,
  replaceSoleAccount,
  type ClaudeCodeUpstreamState,
} from './state'

const HEADER_PREFIX = 'anthropic-ratelimit-'

export interface ClaudeCodeQuotaWindow {
  status: string | null
  reset: string | null
  utilization: number | null
}

export interface ClaudeCodeQuotaSevenDay extends ClaudeCodeQuotaWindow {
  surpassedThreshold: boolean | null
}

export interface ClaudeCodeQuotaOverage extends ClaudeCodeQuotaWindow {
  disabledReason: string | null
}

export interface ClaudeCodeQuotaSnapshot {
  status: string | null
  reset: string | null
  fallbackAvailable: boolean | null
  fallbackPercentage: number | null
  representativeClaim: string | null
  overage: ClaudeCodeQuotaOverage | null
  fiveHour: ClaudeCodeQuotaWindow | null
  sevenDay: ClaudeCodeQuotaSevenDay | null
  raw: Record<string, string>
}

const parseUnixSecondsToIso = (raw: string | null): string | null => {
  if (raw === null) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return new Date(n * 1000).toISOString()
}

const parseNumber = (raw: string | null): number | null => {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

const parseBoolean = (raw: string | null): boolean | null => {
  if (raw === null) return null
  const lower = raw.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  return null
}

const collectRaw = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith(HEADER_PREFIX)) {
      out[name.toLowerCase()] = value
    }
  })
  return out
}

const buildFiveHourWindow = (headers: Headers): ClaudeCodeQuotaWindow | null => {
  const status = headers.get(`${HEADER_PREFIX}unified-5h-status`)
  const reset = headers.get(`${HEADER_PREFIX}unified-5h-reset`)
  const util = headers.get(`${HEADER_PREFIX}unified-5h-utilization`)
  if (status === null && reset === null && util === null) return null
  return {
    status,
    reset: parseUnixSecondsToIso(reset),
    utilization: parseNumber(util),
  }
}

const buildSevenDayWindow = (headers: Headers): ClaudeCodeQuotaSevenDay | null => {
  const status = headers.get(`${HEADER_PREFIX}unified-7d-status`)
  const reset = headers.get(`${HEADER_PREFIX}unified-7d-reset`)
  const util = headers.get(`${HEADER_PREFIX}unified-7d-utilization`)
  const surpassed = headers.get(`${HEADER_PREFIX}unified-7d-surpassed-threshold`)
  if (status === null && reset === null && util === null && surpassed === null) return null
  return {
    status,
    reset: parseUnixSecondsToIso(reset),
    utilization: parseNumber(util),
    surpassedThreshold: parseBoolean(surpassed),
  }
}

const buildOverage = (headers: Headers): ClaudeCodeQuotaOverage | null => {
  const status = headers.get(`${HEADER_PREFIX}unified-overage-status`)
  const reset = headers.get(`${HEADER_PREFIX}unified-overage-reset`)
  const util = headers.get(`${HEADER_PREFIX}unified-overage-utilization`)
  const disabledReason = headers.get(`${HEADER_PREFIX}unified-overage-disabled-reason`)
  if (status === null && reset === null && util === null && disabledReason === null) return null
  return {
    status,
    reset: parseUnixSecondsToIso(reset),
    utilization: parseNumber(util),
    disabledReason,
  }
}

export const parseClaudeCodeQuotaHeaders = (headers: Headers): ClaudeCodeQuotaSnapshot => {
  const fallbackHeader = headers.get(`${HEADER_PREFIX}unified-fallback`)
  return {
    status: headers.get(`${HEADER_PREFIX}unified-status`),
    reset: parseUnixSecondsToIso(headers.get(`${HEADER_PREFIX}unified-reset`)),
    fallbackAvailable: fallbackHeader === null ? null : fallbackHeader === 'available',
    fallbackPercentage: parseNumber(headers.get(`${HEADER_PREFIX}unified-fallback-percentage`)),
    representativeClaim: headers.get(`${HEADER_PREFIX}unified-representative-claim`),
    overage: buildOverage(headers),
    fiveHour: buildFiveHourWindow(headers),
    sevenDay: buildSevenDayWindow(headers),
    raw: collectRaw(headers),
  }
}

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value))

const isBooleanOrNull = (value: unknown): value is boolean | null =>
  value === null || typeof value === 'boolean'

const assertWindow = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`)
  }
  const obj = value as Record<string, unknown>
  if (!isStringOrNull(obj.status)) throw new TypeError(`${where}.status must be a string or null`)
  if (!isStringOrNull(obj.reset)) throw new TypeError(`${where}.reset must be a string or null`)
  if (!isNumberOrNull(obj.utilization))
    throw new TypeError(`${where}.utilization must be a number or null`)
}

export function assertClaudeCodeQuotaSnapshot(
  value: unknown,
  where: string,
): asserts value is ClaudeCodeQuotaSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`)
  }
  const obj = value as Record<string, unknown>
  if (!isStringOrNull(obj.status)) throw new TypeError(`${where}.status must be a string or null`)
  if (!isStringOrNull(obj.reset)) throw new TypeError(`${where}.reset must be a string or null`)
  if (!isBooleanOrNull(obj.fallbackAvailable))
    throw new TypeError(`${where}.fallbackAvailable must be boolean or null`)
  if (!isNumberOrNull(obj.fallbackPercentage))
    throw new TypeError(`${where}.fallbackPercentage must be number or null`)
  if (!isStringOrNull(obj.representativeClaim))
    throw new TypeError(`${where}.representativeClaim must be a string or null`)
  if (obj.overage !== null) {
    assertWindow(obj.overage, `${where}.overage`)
    if (!isStringOrNull((obj.overage as Record<string, unknown>).disabledReason)) {
      throw new TypeError(`${where}.overage.disabledReason must be a string or null`)
    }
  }
  if (obj.fiveHour !== null) assertWindow(obj.fiveHour, `${where}.fiveHour`)
  if (obj.sevenDay !== null) {
    assertWindow(obj.sevenDay, `${where}.sevenDay`)
    if (!isBooleanOrNull((obj.sevenDay as Record<string, unknown>).surpassedThreshold)) {
      throw new TypeError(`${where}.sevenDay.surpassedThreshold must be boolean or null`)
    }
  }
  if (typeof obj.raw !== 'object' || obj.raw === null || Array.isArray(obj.raw)) {
    throw new TypeError(`${where}.raw must be a plain object`)
  }
}

const TTL_FLOOR_MS = 24 * 60 * 60 * 1000

// Bound TTL by the furthest reset horizon (unified, 5h, 7d, overage) so a hot
// account's snapshot survives its window; floor at 24h so dashboard reads
// survive quiet periods between bursts.
export const computeClaudeCodeQuotaTtlMs = (
  snapshot: ClaudeCodeQuotaSnapshot,
  now: Date,
): number => {
  const horizons = [
    snapshot.reset,
    snapshot.fiveHour?.reset ?? null,
    snapshot.sevenDay?.reset ?? null,
    snapshot.overage?.reset ?? null,
  ]
    .map((s) => (s ? new Date(s).getTime() - now.getTime() : 0))
    .filter((ms) => ms > 0)
  return Math.max(TTL_FLOOR_MS, ...horizons)
}

// Claude Code state carries one account with a single `quotaSnapshot` slot
// (unlike codex's keyed active-limit map). Freshness gated inline by
// computeClaudeCodeQuotaTtlMs; stale reads as absent.
export const getClaudeCodeQuota = async (
  upstreamId: string,
): Promise<ClaudeCodeQuotaSnapshot | null> => {
  const fresh = await getUpstreamRepo().getById(upstreamId)
  if (!fresh) return null
  const state = readClaudeCodeUpstreamState(fresh.state)
  const account = state.accounts[0]
  if (!account?.quotaSnapshot) return null
  const now = new Date()
  const ttlMs = computeClaudeCodeQuotaTtlMs(account.quotaSnapshot.data, now)
  if (now.getTime() - account.quotaSnapshot.fetchedAt > ttlMs) return null
  return account.quotaSnapshot.data
}

export const putClaudeCodeQuota = async (
  upstreamId: string,
  snapshot: ClaudeCodeQuotaSnapshot,
): Promise<void> => {
  // Stamped before the write so a replay against a winning sibling produces
  // the same document rather than a later `fetchedAt`.
  const fetchedAt = Date.now()
  await getUpstreamRepo().saveState<ClaudeCodeUpstreamState>(upstreamId, (current) => {
    const state = readClaudeCodeUpstreamState(current)
    return replaceSoleAccount(state, (account) => ({
      ...account,
      quotaSnapshot: { fetchedAt, data: snapshot },
    }))
  })
}
