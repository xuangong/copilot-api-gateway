// packages/gateway/tests/quota-estimator.test.ts
import { expect, test } from "bun:test"
import {
  DEFAULT_K_SHARE_PER_USD, burnRateUsdPerHour, effectiveK, estimateShare, kLearned, learn, projectShare, weightedQuantile,
  type EstimatorParams, type LearnResult, type ReadPoint,
} from "../src/quota-balance/estimator"

const H = 3_600_000
const T0 = Date.UTC(2026, 10, 3)
const params = (over: Partial<EstimatorParams> = {}): EstimatorParams => ({ k: 0.02, kSamples: 5, o: 0.001, ...over })

test("estimated share = last read + k x gateway cost since the read + o x hours since the read", () => {
  const at = T0
  const e = estimateShare({ lastRead: { at, share: 0.5, unlimited: false }, params: params(), costSinceReadUsd: 10, monthCostUsd: 99, now: at + 10 * H })
  expect(e).toMatchObject({ known: true, unlimited: false })
  expect(e.usedShare).toBeCloseTo(0.71, 10)
})

test("few samples err high: the conservative k is at least the fallback, learned k is used once there are enough samples", () => {
  expect(effectiveK({ k: 0.01, kSamples: 1 })).toBe(DEFAULT_K_SHARE_PER_USD)
  expect(effectiveK({ k: null, kSamples: 0 })).toBe(DEFAULT_K_SHARE_PER_USD)
  expect(effectiveK({ k: 0.5, kSamples: 2 })).toBe(0.5)
  expect(effectiveK({ k: 0.01, kSamples: 3 })).toBe(0.01)
  expect(effectiveK({ k: 0.01, kSamples: 0 }, 0.3)).toBe(0.3)
})

test("a member without a read is unknown; an unlimited one is known with nothing used", () => {
  expect(estimateShare({ lastRead: null, params: params(), costSinceReadUsd: 5, monthCostUsd: 5, now: T0 })).toEqual({ known: false, unlimited: false, usedShare: 0 })
  expect(estimateShare({ lastRead: { at: T0, share: 0, unlimited: true }, params: params(), costSinceReadUsd: 5, monthCostUsd: 5, now: T0 + H })).toEqual({ known: true, unlimited: true, usedShare: 0 })
})

test("after the monthly reset the base is zero: the month's gateway cost and the outside rate since the month began", () => {
  const lastRead = { at: Date.UTC(2026, 9, 31, 12), share: 0.93, unlimited: false }
  const now = Date.UTC(2026, 10, 3, 12) // 60 h into November
  const e = estimateShare({ lastRead, params: params(), costSinceReadUsd: 400, monthCostUsd: 5, now })
  expect(e.usedShare).toBeCloseTo(0.02 * 5 + 0.001 * 60)
})

test("projected month-end share adds outside usage for the hours left and the recent burn over the horizon", () => {
  const now = Date.UTC(2026, 10, 22) // 216 h left
  const projected = projectShare({ usedShare: 0.3, params: params(), burnUsdPerHour: 2, burnHorizonHours: 6, now })
  expect(projected).toBeCloseTo(0.3 + 0.001 * 216 + 0.02 * 2 * 6)
  expect(projectShare({ usedShare: 0.3, params: params(), burnUsdPerHour: 2, burnHorizonHours: 6, now, unlimited: true })).toBe(0)
})

test("burn rate is an exponentially weighted spend per hour over the recent buckets", () => {
  const now = 1_800_000_000_000 - (1_800_000_000_000 % 600_000) + 600_000 // a bucket boundary
  const buckets = Array.from({ length: 18 }, (_, i) => ({ bucket: now / 600_000 - 1 - i, costUsd: 1 })) // $1 per 10 min = $6/h for 3 h
  expect(burnRateUsdPerHour(buckets, now)).toBeCloseTo(5.7, 1)
  expect(burnRateUsdPerHour([], now)).toBe(0)
})

test("weighted low quantile", () => {
  expect(weightedQuantile([], 0.25)).toBeNull()
  expect(weightedQuantile([{ value: 3, weight: 1 }, { value: 1, weight: 1 }, { value: 2, weight: 1 }], 0.25)).toBe(1)
  expect(weightedQuantile([{ value: 1, weight: 1 }, { value: 2, weight: 10 }], 0.25)).toBe(2)
})

interface Plan { ratio?: (i: number) => number; outsidePerHour?: (i: number) => number; entitlement?: (i: number) => number; cost?: number }
/** Reads every 6 h from T0. The share of an interval is ratio x cost + outside x 6 h; a different entitlement rescales the share (same credits). */
function history(n: number, plan: Plan): ReadPoint[] {
  const reads: ReadPoint[] = [{ at: T0, share: 0.05, entitlement: plan.entitlement?.(0) ?? 1000, unlimited: false, costTotalUsd: 0 }]
  for (let i = 1; i <= n; i++) {
    const prev = reads[i - 1]!
    const cost = plan.cost ?? 10
    const entitlement = plan.entitlement?.(i) ?? prev.entitlement
    const grown = prev.share * prev.entitlement + ((plan.ratio?.(i) ?? 0.02) * cost + (plan.outsidePerHour?.(i) ?? 0) * 6) * prev.entitlement
    reads.push({ at: T0 + i * 6 * H, share: grown / entitlement, entitlement, unlimited: false, costTotalUsd: prev.costTotalUsd + cost })
  }
  return reads
}
/** Feeds the reads one at a time, like the reader does. */
function run(reads: ReadPoint[], start: EstimatorParams = { k: null, kSamples: 0, o: 0, oSamples: 0 }): { results: LearnResult[]; params: EstimatorParams; learnSince: number } {
  let current = start
  let learnSince = 0
  const results: LearnResult[] = []
  for (let i = 1; i < reads.length; i++) {
    const result = learn({ prev: current, reads: reads.slice(0, i + 1), read: reads[i]!, learnSince, previousEntitlement: reads[i - 1]!.entitlement, estimatedShareBefore: null })
    results.push(result)
    current = { k: result.k, kSamples: result.kSamples, o: result.o, oSamples: result.oSamples }
    learnSince = result.learnSince
  }
  return { results, params: current, learnSince }
}

test("k is the low end of the observed share per gateway dollar: outside usage only raises the ratio", () => {
  const reads = history(16, { ratio: () => 0.02, outsidePerHour: i => (i % 2 === 0 ? 0.02 : 0) })
  const { params: p } = run(reads)
  expect(p.k).toBeCloseTo(0.02, 4)
  expect(p.kSamples).toBe(16)
})

test("a price or discount change is absorbed within a couple of days of reads", () => {
  const reads = history(32, { ratio: i => (i <= 20 ? 0.02 : 0.04) })
  expect(run(reads.slice(0, 22)).params.k).toBeCloseTo(0.02, 4) // one read after the change: still the old regime
  expect(run(reads).params.k).toBeCloseTo(0.04, 4) // three days after the change
})

test("intervals older than seven days do not count", () => {
  const reads = history(40, { ratio: i => (i <= 8 ? 0.01 : 0.02) })
  expect(run(reads).params.k).toBeCloseTo(0.02, 4)
})

test("outside usage showing up and going away is tracked by o within a few reads", () => {
  const reads = history(16, { ratio: () => 0.02, outsidePerHour: i => (i > 8 && i <= 12 ? 0.01 : 0) })
  const { results } = run(reads)
  expect(results[7]!.o).toBeCloseTo(0, 6)
  expect(results[11]!.o).toBeGreaterThan(0.009) // four intervals into the outside usage: 0.009375
  expect(results[11]!.k).toBeCloseTo(0.02, 4)
  expect(results[14]!.o).toBeLessThan(0.0012) // three clean intervals later
})

test("an interval with little gateway cost does not teach k but still updates o", () => {
  const reads = history(6, { ratio: () => 0.02, cost: 10 })
  const quiet: ReadPoint = { at: reads.at(-1)!.at + 6 * H, share: reads.at(-1)!.share + 0.06, entitlement: 1000, unlimited: false, costTotalUsd: reads.at(-1)!.costTotalUsd + 0.2 }
  const before = run(reads).params
  const after = learn({ prev: before, reads: [...reads, quiet], read: quiet, learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: null })
  expect(after.k).toBeCloseTo(before.k!, 6)
  expect(after.kSamples).toBe(before.kSamples)
  expect(after.o).toBeGreaterThan(before.o)
})

test("the prediction error is the estimate before the read minus the real share, in percentage points", () => {
  const reads = history(3, {})
  const result = learn({ prev: params(), reads, read: reads.at(-1)!, learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: reads.at(-1)!.share + 0.05 })
  expect(result.errorPoints).toBeCloseTo(5, 6)
  const first = learn({ prev: { k: null, kSamples: 0, o: 0 }, reads: reads.slice(0, 1), read: reads[0]!, learnSince: 0, previousEntitlement: null, estimatedShareBefore: null })
  expect(first.errorPoints).toBeNull()
})

test("intervals that cross the monthly reset or show a falling share teach nothing", () => {
  const read = (at: number, share: number, cost: number): ReadPoint => ({ at, share, entitlement: 1000, unlimited: false, costTotalUsd: cost })
  const reads = [read(Date.UTC(2026, 10, 29), 0.7, 0), read(Date.UTC(2026, 10, 30, 18), 0.9, 10), read(Date.UTC(2026, 11, 1, 6), 0.02, 20), read(Date.UTC(2026, 11, 1, 12), 0.1, 24)]
  const { params: p } = run(reads)
  expect(p.kSamples).toBe(2) // Nov 29 -> Nov 30 and Dec 1 06:00 -> 12:00 only
})

test("an entitlement change drops the spanning interval, rescales k and o by old/new, restarts the window and clears the error", () => {
  const before = history(5, { ratio: () => 0.02 })
  const changeAt = before.at(-1)!.at + 6 * H
  const afterChange: ReadPoint = { at: changeAt, share: (before.at(-1)!.share + 0.2) / 2, entitlement: 2000, unlimited: false, costTotalUsd: before.at(-1)!.costTotalUsd + 10 }
  const start = run(before).params
  const result = learn({ prev: { ...start, o: 0.002 }, reads: [...before, afterChange], read: afterChange, learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: 0.9 })
  expect(result.entitlementChange).toEqual({ from: 1000, to: 2000 })
  expect(result.k).toBeCloseTo(0.01, 6)
  expect(result.o).toBeCloseTo(0.001, 9)
  expect(result.kSamples).toBe(0)
  expect(result.errorPoints).toBeNull()
  expect(result.learnSince).toBe(changeAt)
})

test("after an entitlement change only the intervals after it are used, and with few of them the estimate stays conservative", () => {
  const entitlement = (i: number) => (i <= 5 ? 1000 : 2000)
  const reads = history(8, { entitlement, ratio: i => (i <= 5 ? 0.02 : 0.01) })
  const { params: p, learnSince } = run(reads)
  expect(learnSince).toBe(reads[6]!.at)
  expect(p.k).toBeCloseTo(0.01, 4)
  expect(p.kSamples).toBe(2) // reads 6 -> 7 and 7 -> 8; the interval 5 -> 6 spans the change
  expect(effectiveK(p)).toBe(DEFAULT_K_SHARE_PER_USD)
})

const unlimitedAt = (at: number, cost: number): ReadPoint => ({ at, share: 0, entitlement: 0, unlimited: true, costTotalUsd: cost })

test("an unlimited read after an unlimited read leaves the parameters alone", () => {
  const reads = [unlimitedAt(T0, 0), unlimitedAt(T0 + 30 * H, 40)]
  const result = learn({ prev: params(), reads, read: reads[1]!, learnSince: 0, previousEntitlement: 0, estimatedShareBefore: 0 })
  expect(result).toMatchObject({ k: 0.02, kSamples: 5, o: 0.001, errorPoints: null, entitlementChange: null, reset: null })
})

test("metered to unlimited and back is an entitlement change: recorded, window restarted, k reset without rescale", () => {
  const metered = history(5, {})
  const start = run(metered).params
  const toUnlimited = unlimitedAt(metered.at(-1)!.at + 6 * H, 100)
  const a = learn({ prev: start, reads: [...metered, toUnlimited], read: toUnlimited, learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: 0.9 })
  expect(a).toMatchObject({ k: null, kSamples: 0, o: 0, errorPoints: null, learnSince: toUnlimited.at, reset: "unlimited", entitlementChange: { from: 1000, to: 0 } })
  const back: ReadPoint = { at: toUnlimited.at + 6 * H, share: 0.3, entitlement: 500, unlimited: false, costTotalUsd: 110 }
  const b = learn({ prev: { k: null, kSamples: 0, o: 0 }, reads: [...metered, toUnlimited, back], read: back, learnSince: toUnlimited.at, previousEntitlement: 0, estimatedShareBefore: null })
  expect(b).toMatchObject({ k: null, kSamples: 0, learnSince: back.at, reset: "unlimited", entitlementChange: { from: 0, to: 500 } })
})

test("a changed snapshot key or unit form restarts learning without a rescale and is not an entitlement change", () => {
  const base = history(5, {}).map(r => ({ ...r, snapshotKey: "premium_interactions", unitForm: "absolute" }))
  const start = run(base).params
  for (const change of [{ snapshotKey: "ai_credits" }, { unitForm: "percent" }]) {
    const next: ReadPoint = { ...base.at(-1)!, at: base.at(-1)!.at + 6 * H, costTotalUsd: base.at(-1)!.costTotalUsd + 10, ...change }
    const result = learn({ prev: start, reads: [...base, next], read: next, learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: 0.5 })
    expect(result).toMatchObject({ k: null, kSamples: 0, o: 0, errorPoints: null, learnSince: next.at, entitlementChange: null, reset: "source" })
  }
  // An unknown (null) key or unit form never counts as a change.
  const unknown: ReadPoint = { ...base.at(-1)!, at: base.at(-1)!.at + 6 * H, share: base.at(-1)!.share + 0.2, costTotalUsd: base.at(-1)!.costTotalUsd + 10, snapshotKey: null, unitForm: null }
  expect(learn({ prev: start, reads: [...base, unknown], read: unknown, learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: null }).reset).toBeNull()
})

test("an implausible rescale factor (beyond 10x either way) resets instead of rescaling", () => {
  const before = history(5, {})
  const start = run(before).params
  const huge: ReadPoint = { at: before.at(-1)!.at + 6 * H, share: 0.0001, entitlement: 1_000_000, unlimited: false, costTotalUsd: before.at(-1)!.costTotalUsd + 10 }
  const result = learn({ prev: start, reads: [...before, huge], read: huge, learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: null })
  expect(result).toMatchObject({ k: null, kSamples: 0, o: 0, reset: "entitlement", entitlementChange: { from: 1000, to: 1_000_000 } })
  const edge: ReadPoint = { ...huge, entitlement: 10_000 }
  expect(learn({ prev: start, reads: [...before, edge], read: edge, learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: null }).k).toBeCloseTo(start.k! / 10, 9)
})

test("counter lag (no movement, then catch-up) is merged and gives a sensible k instead of collapsing to 0", () => {
  const read = (i: number, share: number, cost: number): ReadPoint => ({ at: T0 + i * 6 * H, share, entitlement: 1000, unlimited: false, costTotalUsd: cost })
  const reads = [read(0, 0.05, 0), read(1, 0.07, 1), read(2, 0.09, 2), read(3, 0.09, 3), read(4, 0.13, 4), read(5, 0.15, 5)]
  const { params: p } = run(reads)
  // 0.02 per $ regime; the lagged pair (0, then 0.04 for $2) is merged into one interval at 0.02 per $.
  expect(p.k).toBeCloseTo(0.02, 4)
  expect(p.kSamples).toBe(4)
  // Without merging, the catch-up read alone (0.04 for $1) would pass as 0.04 and the lag as 0: the pooled floor and the merge keep k at the true value.
})

test("k never falls below half the pooled ratio of the window", () => {
  const read = (i: number, share: number, cost: number): ReadPoint => ({ at: T0 + i * 6 * H, share, entitlement: 1000, unlimited: false, costTotalUsd: cost })
  // One interval at 0.001 per $ among intervals at 0.02 per $: the quarter-quantile alone would be ~0.001.
  const reads = [read(0, 0, 0), read(1, 0.001, 1), read(2, 0.021, 2), read(3, 0.041, 3), read(4, 0.061, 4)]
  const { params: p } = run(reads)
  const pooled = 0.061 / 4
  expect(p.k).toBeGreaterThanOrEqual(0.5 * pooled - 1e-12)
})

test("the new read is passed explicitly: a back-dated read between older ones is learned correctly and the window is anchored on the newest read", () => {
  const reads = history(8, {})
  const backdated: ReadPoint = { ...reads[4]!, at: reads[4]!.at + 3 * H, share: (reads[4]!.share + reads[5]!.share) / 2, costTotalUsd: (reads[4]!.costTotalUsd + reads[5]!.costTotalUsd) / 2 }
  const shuffled = [reads[8]!, backdated, ...reads.slice(0, 8)]
  const result = learn({ prev: params(), reads: shuffled, read: backdated, learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: null })
  expect(result.k).toBeCloseTo(0.02, 4)
  expect(result.reset).toBeNull()
})

test("o waits for a learned k, then the first residual seeds it and later ones are averaged", () => {
  const reads = history(5, { ratio: () => 0.02, outsidePerHour: i => (i === 3 ? 0.01 : 0) })
  const { results } = run(reads)
  expect(results[1]!.o).toBe(0) // k not learned yet (2 intervals)
  expect(results[2]!.o).toBeCloseTo(0.01, 6) // third interval: seeded with the residual, not halved
  expect(results[2]!.oSamples).toBe(1)
  expect(results[3]!.o).toBeCloseTo(0.005, 6) // clean interval averaged in
})

test("a non-finite input never produces non-finite parameters", () => {
  const reads = history(3, {})
  const bad: ReadPoint = { ...reads.at(-1)!, at: reads.at(-1)!.at + 6 * H, share: Number.NaN, costTotalUsd: reads.at(-1)!.costTotalUsd + 10 }
  const result = learn({ prev: params(), reads: [...reads, bad], read: bad, learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: Number.NaN })
  expect(Number.isFinite(result.o)).toBe(true)
  expect(result.k === null || Number.isFinite(result.k)).toBe(true)
  expect(result.errorPoints).toBeNull()
})

test("the estimate says whether k is learned, so a provisional cut-off can require it", () => {
  const lastRead = { at: T0, share: 0.5, unlimited: false }
  expect(estimateShare({ lastRead, params: params({ kSamples: 5 }), costSinceReadUsd: 1, monthCostUsd: 1, now: T0 }).kLearned).toBe(true)
  expect(estimateShare({ lastRead, params: params({ kSamples: 1 }), costSinceReadUsd: 1, monthCostUsd: 1, now: T0 }).kLearned).toBe(false)
  expect(kLearned({ k: null, kSamples: 9 })).toBe(false)
})
