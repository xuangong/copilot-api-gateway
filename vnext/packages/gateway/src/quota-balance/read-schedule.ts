// packages/gateway/src/quota-balance/read-schedule.ts
import { MAX_READS_PER_DAY, utcDayKey, type GroupSettings } from "../repo/quota-balance.ts"
import { HOUR_MS, MINUTE_MS, monthStartMs, nextMonthStartMs } from "./time.ts"

/** Never two reads of one member closer than this (a failed attempt counts). */
export const MIN_READ_GAP_MS = HOUR_MS
/** Floor for a manual refresh and for the page-open read. */
export const MANUAL_MIN_READ_GAP_MS = 10 * MINUTE_MS
export const MIN_INTERVAL_HOURS = 1
export const JITTER_MS = 30 * MINUTE_MS
/** Reads (and hard-line decisions from them) wait this long after 00:00 UTC on the 1st: GitHub may still serve last month's numbers. */
export const MONTH_START_SETTLE_MS = 30 * MINUTE_MS

export type ReadReason = "manual" | "join" | "monthly" | "hard" | "soft" | "confirm" | "drift" | "scheduled"

/** After |error| > 5 points the interval halves (floor 1 h); after |error| < 3 points it grows by 1.5x up to the setting. */
export function nextIntervalHours(previous: number, errorPoints: number | null, maxHours: number): number {
  const clamp = (hours: number) => Math.max(MIN_INTERVAL_HOURS, Math.min(maxHours, hours))
  if (errorPoints === null) return clamp(previous)
  const size = Math.abs(errorPoints)
  if (size > 5) return clamp(previous / 2)
  if (size < 3) return clamp(previous * 1.5)
  return clamp(previous)
}

/** 1 h, 2 h, 4 h ... after consecutive failures, capped at the read interval. */
export function backoffHours(failures: number, maxHours: number): number {
  return Math.min(Math.max(MIN_INTERVAL_HOURS, maxHours), 2 ** Math.max(0, failures - 1))
}

/** `now + interval` with up to 30 minutes of jitter either way, at least the floor away, and not later than the first read of next month (00:00 UTC on the 1st plus 30-60 minutes). */
export function scheduleNextRead(now: number, intervalHours: number, random: () => number): number {
  const jitter = (random() * 2 - 1) * JITTER_MS
  const planned = now + intervalHours * HOUR_MS + jitter
  // The floor wins over the monthly cap (late in the month the cap could otherwise land inside the floor).
  return Math.max(now + MIN_READ_GAP_MS, Math.min(planned, nextMonthStartMs(now) + MONTH_START_SETTLE_MS + random() * JITTER_MS))
}

/**
 * Whether the estimate alone may cut a member off at the hard line (a provisional cut-off). Only when k is learned (`kLearned` of the estimator):
 * with the fallback k the estimate is deliberately high and would cut an account that is not nearly exhausted. Reaching the hard line with the
 * fallback k still triggers an immediate read (`readDecision`, floor permitting); the soft line may use the estimate either way.
 */
export function provisionalCutoffAllowed(input: { kLearned: boolean; estimatedShare: number; unlimited: boolean; settings: Pick<GroupSettings, "hardShare"> }): boolean {
  return input.kLearned && !input.unlimited && input.estimatedShare >= input.settings.hardShare
}

export interface SchedState {
  lastReadAt: number | null
  lastReadShare: number | null
  lastAttemptAt: number | null
  nextReadAt: number
  failures: number
  unlimited: boolean
  /** GitHub reads attempted on `dayKey` (UTC day), manual ones excluded; absent: no cap known. */
  dayKey?: string
  dayReads?: number
}
type Lines = Pick<GroupSettings, "softShare" | "hardShare" | "confirmShare" | "driftShare" | "readIntervalHours">

/**
 * The earliest instant a read of this member is allowed: the floor after the last attempt and, with `now`, the daily cap (at most `MAX_READS_PER_DAY` per UTC
 * day, every trigger except a manual read: the next one is allowed at the next 00:00 UTC). The database claim enforces both atomically.
 */
export function readAllowedAt(state: SchedState, settings: Pick<GroupSettings, "readIntervalHours">, manual: boolean, now?: number): number {
  const floor = state.lastAttemptAt === null ? 0 : state.lastAttemptAt + readFloorMs(state, settings, manual)
  if (manual || now === undefined || state.dayKey !== utcDayKey(now) || (state.dayReads ?? 0) < MAX_READS_PER_DAY) return floor
  return Math.max(floor, Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1))
}

/** The gap an attempt must keep from the previous one: 10 minutes for a manual/page-open read, else one hour or the failure back-off. */
export function readFloorMs(state: Pick<SchedState, "failures">, settings: Pick<GroupSettings, "readIntervalHours">, manual: boolean): number {
  if (manual) return MANUAL_MIN_READ_GAP_MS
  return state.failures > 0 ? Math.max(MIN_READ_GAP_MS, backoffHours(state.failures, settings.readIntervalHours) * HOUR_MS) : MIN_READ_GAP_MS
}

export interface ReadDecision {
  read: boolean
  /** What asks for the read, also when the floor blocks it. */
  reason: ReadReason | null
  /** When the floor lets the read through; null unless blocked. */
  blockedUntil: number | null
}

export function readDecision(input: { now: number; state: SchedState; estimatedShare: number; settings: Lines; manual?: boolean }): ReadDecision {
  const { now, state, settings } = input
  const manual = input.manual === true
  const trigger = manual ? "manual" : triggerOf(now, state, input.estimatedShare, settings)
  if (trigger === null) return { read: false, reason: null, blockedUntil: null }
  const allowedAt = readAllowedAt(state, settings, manual, now)
  return now >= allowedAt ? { read: true, reason: trigger, blockedUntil: null } : { read: false, reason: trigger, blockedUntil: allowedAt }
}

function triggerOf(now: number, state: SchedState, estimate: number, settings: Lines): ReadReason | null {
  const gate = monthStartMs(now) + MONTH_START_SETTLE_MS
  // Nothing is read in the first 30 minutes of a month: GitHub may still serve last month's numbers.
  if (state.lastReadAt === null) return now >= gate ? "join" : null
  // A read from before that (including one taken inside the window by a page open or a manual refresh) is not this month's base.
  const monthly = state.lastReadAt < gate
  if (monthly) {
    const due = state.lastReadAt < monthStartMs(now) ? now >= state.nextReadAt : true
    return now >= gate && due ? "monthly" : null
  }
  if (!state.unlimited) {
    const base = state.lastReadShare ?? 0
    const crossed = (line: number) => estimate >= line && base < line
    if (crossed(settings.hardShare)) return "hard"
    if (crossed(settings.softShare)) return "soft"
    if (crossed(settings.confirmShare)) return "confirm"
    if (Math.abs(estimate - base) > settings.driftShare) return "drift"
  }
  return now >= state.nextReadAt ? "scheduled" : null
}
