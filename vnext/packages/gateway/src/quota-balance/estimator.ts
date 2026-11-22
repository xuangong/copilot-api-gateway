// packages/gateway/src/quota-balance/estimator.ts
import { COST_BUCKET_MS, type CostBucket } from "../repo/quota-balance.ts"
import { HOUR_MS, hoursLeftInMonth, monthKey, monthStartMs } from "./time.ts"

/**
 * Share of the allowance per gateway USD assumed for a member that has not taught us its own k yet. Deliberately high (errs towards
 * "more used"); set from the Task 1 findings: 1 / (smallest plan's monthly allowance in USD), rounded up to one significant digit.
 */
export const DEFAULT_K_SHARE_PER_USD = 0.1
export const MIN_K_SAMPLES = 3
export const K_WINDOW_MS = 7 * 24 * HOUR_MS
export const K_HALF_LIFE_MS = 24 * HOUR_MS
export const K_QUANTILE = 0.25
export const K_MIN_INTERVAL_COST_USD = 1
export const O_ALPHA = 0.5
export const O_MIN_INTERVAL_HOURS = 0.5
export const BURN_TAU_MS = HOUR_MS

export interface EstimatorParams {
  /** Share per gateway USD; null until learned. */
  k: number | null
  /** Usable intervals behind `k`. */
  kSamples: number
  /** Outside usage, share per hour. */
  o: number
  /** Updates behind `o`; 0 (or absent) means nothing learned yet and the next residual seeds `o`. */
  oSamples?: number
}
export interface ReadPoint {
  at: number; share: number; entitlement: number; unlimited: boolean; costTotalUsd: number
  /** Which snapshot and unit form the read came from; a change between reads restarts learning (null = unknown, never counts as a change). */
  snapshotKey?: string | null
  unitForm?: string | null
}
/** k is trusted (a provisional cut-off on the estimate may rest on it) only with enough usable intervals. */
export const kLearned = (params: Pick<EstimatorParams, "k" | "kSamples">): boolean => params.k !== null && params.kSamples >= MIN_K_SAMPLES
/** Rescale factors outside this range are not believable (a different unit rather than a plan change): learning is reset instead. */
export const RESCALE_MIN = 0.1
export const RESCALE_MAX = 10
export const K_POOLED_FLOOR = 0.5

/** Learned k, or at least the fallback while there are fewer than MIN_K_SAMPLES intervals: an under-estimate must not send sessions to a nearly exhausted account. */
export function effectiveK(params: Pick<EstimatorParams, "k" | "kSamples">, fallback: number = DEFAULT_K_SHARE_PER_USD): number {
  if (params.k === null) return fallback
  return params.kSamples >= MIN_K_SAMPLES ? params.k : Math.max(params.k, fallback)
}

export interface EstimateInput {
  lastRead: { at: number; share: number; unlimited: boolean } | null
  params: EstimatorParams
  /** Gateway cost since the last read. */
  costSinceReadUsd: number
  /** Gateway cost since the start of this UTC month (the base after a reset). */
  monthCostUsd: number
  now: number
  kFallback?: number
}
/** `kLearned` false means the numbers rest on the fallback k: they may order members and ask for a read, but must not cut a member off. */
export interface Estimate { known: boolean; unlimited: boolean; usedShare: number; kLearned?: boolean }

export function estimateShare(input: EstimateInput): Estimate {
  const { lastRead, params, now } = input
  if (!lastRead) return { known: false, unlimited: false, usedShare: 0 }
  if (lastRead.unlimited) return { known: true, unlimited: true, usedShare: 0 }
  const k = effectiveK(params, input.kFallback)
  const learned = kLearned(params)
  const monthStart = monthStartMs(now)
  if (lastRead.at < monthStart) {
    return { known: true, unlimited: false, kLearned: learned, usedShare: k * Math.max(0, input.monthCostUsd) + params.o * Math.max(0, now - monthStart) / HOUR_MS }
  }
  return { known: true, unlimited: false, kLearned: learned, usedShare: lastRead.share + k * Math.max(0, input.costSinceReadUsd) + params.o * Math.max(0, now - lastRead.at) / HOUR_MS }
}

/** Gateway spend per hour, exponentially weighted (time constant 1 h) over the given 10-minute buckets. */
export function burnRateUsdPerHour(buckets: readonly CostBucket[], now: number): number {
  let weighted = 0
  for (const bucket of buckets) {
    const age = Math.max(0, now - (bucket.bucket + 0.5) * COST_BUCKET_MS)
    weighted += bucket.costUsd * Math.exp(-age / BURN_TAU_MS)
  }
  return weighted / (BURN_TAU_MS / HOUR_MS)
}

export interface ProjectInput {
  usedShare: number
  params: EstimatorParams
  burnUsdPerHour: number
  burnHorizonHours: number
  now: number
  kFallback?: number
  unlimited?: boolean
}
/** Projected month-end share: used + outside rate x hours left + k x recent burn x horizon. */
export function projectShare(input: ProjectInput): number {
  if (input.unlimited) return 0
  const k = effectiveK(input.params, input.kFallback)
  return input.usedShare + input.params.o * hoursLeftInMonth(input.now) + k * input.burnUsdPerHour * input.burnHorizonHours
}

export function weightedQuantile(samples: ReadonlyArray<{ value: number; weight: number }>, q: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a.value - b.value)
  const total = sorted.reduce((sum, sample) => sum + sample.weight, 0)
  let cumulative = 0
  for (const sample of sorted) {
    cumulative += sample.weight
    if (cumulative >= q * total - 1e-12) return sample.value
  }
  return sorted[sorted.length - 1]!.value
}

interface Interval { from: ReadPoint; to: ReadPoint; dCost: number; dShare: number; hours: number }
const entitlementChanged = (a: number, b: number): boolean => Math.abs(a - b) > 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1)
const sourceChanged = (a: ReadPoint, b: ReadPoint): boolean =>
  (a.snapshotKey != null && b.snapshotKey != null && a.snapshotKey !== b.snapshotKey) || (a.unitForm != null && b.unitForm != null && a.unitForm !== b.unitForm)

/**
 * Consecutive reads that can teach: after `learnSince`, same entitlement, snapshot and unit form, same UTC month, share not falling, metered.
 * An interval whose share did not move although real money was spent (counter lag: GitHub's figure trails) is not used on its own; its cost
 * is merged into the next usable interval, so the catch-up read does not show up as an impossibly high ratio and the lag as an impossibly low one.
 */
function usableIntervals(reads: readonly ReadPoint[], learnSince: number): Interval[] {
  const out: Interval[] = []
  let anchor: ReadPoint | null = null
  for (let i = 1; i < reads.length; i++) {
    const to = reads[i]!
    const from: ReadPoint = anchor ?? reads[i - 1]!
    const adjacent = reads[i - 1]!
    if (adjacent.unlimited || to.unlimited || adjacent.at < learnSince
      || entitlementChanged(adjacent.entitlement, to.entitlement) || sourceChanged(adjacent, to) || monthKey(adjacent.at) !== monthKey(to.at)) { anchor = null; continue }
    const dShare = to.share - from.share
    const dCost = to.costTotalUsd - from.costTotalUsd
    if (dShare < 0 || dCost < 0) { anchor = null; continue }
    if (dShare === 0 && dCost >= K_MIN_INTERVAL_COST_USD) { anchor = from; continue }
    anchor = null
    out.push({ from, to, dCost, dShare, hours: (to.at - from.at) / HOUR_MS })
  }
  return out
}

export interface LearnInput {
  prev: EstimatorParams
  /** Reads of the member including the new one, in any order (a back-dated manual calibration is not the latest); at least the last seven days. */
  reads: readonly ReadPoint[]
  /** The read being recorded; one of `reads`. */
  read: ReadPoint
  /** Reads before this instant do not count (restart after an entitlement change). */
  learnSince: number
  /** Entitlement of the previous read (the state before the new read); null for the first read. */
  previousEntitlement: number | null
  /** Estimated share just before the new read; null when the member was unknown. */
  estimatedShareBefore: number | null
  kFallback?: number
}
export interface LearnResult extends EstimatorParams {
  oSamples: number
  /** Percentage points: estimate before the read minus the real share; null when not comparable. */
  errorPoints: number | null
  learnSince: number
  /** Set for an entitlement change and for a switch between unlimited and metered (0 stands for unlimited); not for a change of snapshot or unit form. */
  entitlementChange: { from: number; to: number } | null
  /** Why learning restarted, if it did. */
  reset: "entitlement" | "unlimited" | "source" | null
}

const finite = (value: number | null): boolean => value === null || Number.isFinite(value)

export function learn(input: LearnInput): LearnResult {
  const { prev, read: newest } = input
  const sorted = [...input.reads].sort((a, b) => a.at - b.at)
  const index = sorted.findIndex(r => r.at === newest.at)
  const before = index > 0 ? sorted[index - 1]! : null
  const latestAt = sorted[sorted.length - 1]?.at ?? newest.at
  const restart = (reset: NonNullable<LearnResult["reset"]>, change: LearnResult["entitlementChange"], rescale: number | null): LearnResult => {
    const believable = rescale !== null && rescale >= RESCALE_MIN && rescale <= RESCALE_MAX
    return {
      k: believable && prev.k !== null ? prev.k * rescale : null, kSamples: 0, o: believable ? prev.o * rescale : 0, oSamples: believable ? prev.oSamples ?? 0 : 0,
      errorPoints: null, learnSince: newest.at, entitlementChange: change, reset,
    }
  }
  const previousUnlimited = before ? before.unlimited : input.previousEntitlement === 0
  const hasPrevious = before !== null || input.previousEntitlement !== null
  if (hasPrevious && previousUnlimited !== newest.unlimited) {
    // Unlimited <-> metered: shares are not comparable; relearn from here with the conservative bias.
    return restart("unlimited", { from: before ? (before.unlimited ? 0 : before.entitlement) : input.previousEntitlement ?? 0, to: newest.unlimited ? 0 : newest.entitlement }, null)
  }
  if (newest.unlimited) return { ...prev, oSamples: prev.oSamples ?? 0, errorPoints: null, learnSince: input.learnSince, entitlementChange: null, reset: null }
  if (before && sourceChanged(before, newest)) return restart("source", null, null)
  const previousEntitlement = before ? before.entitlement : input.previousEntitlement
  if (previousEntitlement !== null && previousEntitlement > 0 && entitlementChanged(previousEntitlement, newest.entitlement)) {
    // The same credits are a different share of the new total; relearn from here with the conservative bias.
    return restart("entitlement", { from: previousEntitlement, to: newest.entitlement }, previousEntitlement / newest.entitlement)
  }
  const errorPoints = input.estimatedShareBefore === null || before === null ? null : (input.estimatedShareBefore - newest.share) * 100
  const intervals = usableIntervals(sorted, input.learnSince)
  const inWindow = intervals.filter(i => i.dCost >= K_MIN_INTERVAL_COST_USD && latestAt - i.to.at <= K_WINDOW_MS)
  const samples = inWindow.map(i => ({ value: i.dShare / i.dCost, weight: Math.pow(0.5, (latestAt - i.to.at) / K_HALF_LIFE_MS) }))
  // The low quantile resists outside usage but can collapse after lagged counters; never go below half the pooled ratio of the window.
  const pooledCost = inWindow.reduce((sum, i) => sum + i.dCost, 0)
  const pooled = pooledCost > 0 ? inWindow.reduce((sum, i) => sum + i.dShare, 0) / pooledCost : null
  const quantile = weightedQuantile(samples, K_QUANTILE)
  const k = quantile === null ? prev.k : pooled === null ? quantile : Math.max(quantile, K_POOLED_FLOOR * pooled)
  const kSamples = samples.length
  let o = prev.o
  const last = intervals.find(i => i.to.at === newest.at)
  let oSamples = prev.oSamples ?? 0
  // With the fallback k (too few intervals) the residual would be zero by construction: wait until k is learned.
  if (last && last.hours >= O_MIN_INTERVAL_HOURS && kLearned({ k, kSamples })) {
    const residual = Math.max(0, last.dShare - effectiveK({ k, kSamples }, input.kFallback) * last.dCost) / last.hours
    // The first usable interval seeds o (nothing learned yet), later ones are averaged in.
    o = oSamples === 0 ? residual : O_ALPHA * residual + (1 - O_ALPHA) * prev.o
    oSamples += 1
  }
  if (!finite(k) || !Number.isFinite(o)) return { ...prev, errorPoints: null, learnSince: input.learnSince, entitlementChange: null, reset: null, oSamples: prev.oSamples ?? 0 }
  return { k, kSamples, o, oSamples, errorPoints: Number.isFinite(errorPoints ?? 0) ? errorPoints : null, learnSince: input.learnSince, entitlementChange: null, reset: null }
}
