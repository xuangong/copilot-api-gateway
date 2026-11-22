// packages/gateway/src/quota-balance/facts.ts
import { COST_BUCKET_MS, type GroupSettings, type MemberFacts, type MemberPlanFact, type QuotaState } from "../repo/quota-balance.ts"
import { DEFAULT_K_SHARE_PER_USD, MIN_K_SAMPLES, burnRateUsdPerHour, kLearned, estimateShare, projectShare, type Estimate, type EstimatorParams } from "./estimator.ts"
import { warn, type QuotaDeps } from "./deps.ts"
import type { MemberView } from "./selection.ts"
import { MONTH_START_SETTLE_MS } from "./read-schedule.ts"
import { HOUR_MS, monthKey, monthStartMs } from "./time.ts"

const EMPTY_FACTS: MemberFacts = { state: null, costSinceReadUsd: 0, monthCostUsd: 0, burnBuckets: [] }

/**
 * Estimator state and gateway cost of group members, per isolate (20 s TTL). The cost this isolate records itself is added at once
 * (`addLocalCost`), so balancing sees the gateway's own traffic immediately; costs recorded before a load started are assumed to be in its result.
 * A cold id waits for its load; a stale one is served and refreshed in the background. Fail-open to empty facts.
 */
export class MemberFactsCache {
  private readonly entries = new Map<string, { facts: MemberFacts; at: number; localAtLoad: number }>()
  private readonly local = new Map<string, number>()
  private readonly reloading = new Set<string>()
  /** Members whose last load failed while nothing was cached: eligible but ranked last (`viewMembers`). Members with cached facts keep using them. */
  readonly unavailable = new Set<string>()
  /** Plan facts of every grouped member (peer-seeded k, D33): one query, same TTL; a failed load keeps the previous answer (or none: the current fallback). */
  private planCache: { plans: readonly MemberPlanFact[]; at: number } | null = null
  private planLoad: Promise<void> | null = null

  constructor(private readonly deps: QuotaDeps, readonly ttlMs = 20_000) {}

  async get(ids: readonly string[], options: { fresh?: boolean } = {}): Promise<Map<string, MemberFacts>> {
    const now = this.deps.now()
    const cold = ids.filter(id => options.fresh || !this.entries.has(id))
    // One background reload per member at a time: concurrent requests on a stale entry do not stack loads.
    const stale = ids.filter(id => !cold.includes(id) && !this.reloading.has(id) && now - this.entries.get(id)!.at >= this.ttlMs)
    if (cold.length > 0) await this.load(cold, now)
    if (stale.length > 0) {
      for (const id of stale) this.reloading.add(id)
      this.deps.schedule(this.load(stale, now).finally(() => { for (const id of stale) this.reloading.delete(id) }))
    }
    return new Map(ids.map(id => [id, this.view(id, now)]))
  }

  async plans(options: { fresh?: boolean } = {}): Promise<readonly MemberPlanFact[]> {
    const now = this.deps.now()
    if (!this.planCache || options.fresh) await this.loadPlans(now)
    else if (now - this.planCache.at >= this.ttlMs && !this.planLoad) this.deps.schedule(this.loadPlans(now))
    return this.planCache?.plans ?? []
  }

  private loadPlans(now: number): Promise<void> {
    if (this.planLoad) return this.planLoad
    const work: Promise<void> = (async () => {
      try { this.planCache = { plans: await this.deps.repo().quotaBalance.listPlanFacts(), at: now } } catch (error) {
        warn("quota_plan_facts_refresh_failed", error)
        this.planCache = { plans: this.planCache?.plans ?? [], at: now }
      }
    })().finally(() => { if (this.planLoad === work) this.planLoad = null })
    this.planLoad = work
    return work
  }

  addLocalCost(upstreamId: string, costUsd: number): void { this.local.set(upstreamId, (this.local.get(upstreamId) ?? 0) + costUsd) }
  invalidate(upstreamId?: string): void { if (upstreamId === undefined) { this.entries.clear(); this.planCache = null } else this.entries.delete(upstreamId) }

  private view(id: string, now: number): MemberFacts {
    const entry = this.entries.get(id)
    if (!entry) return EMPTY_FACTS
    const delta = Math.max(0, (this.local.get(id) ?? 0) - entry.localAtLoad)
    if (delta === 0) return entry.facts
    const bucket = Math.floor(now / COST_BUCKET_MS)
    return {
      state: entry.facts.state,
      costSinceReadUsd: entry.facts.costSinceReadUsd + delta,
      monthCostUsd: entry.facts.monthCostUsd + delta,
      burnBuckets: [...entry.facts.burnBuckets, { bucket, costUsd: delta }],
    }
  }

  private async load(ids: readonly string[], now: number): Promise<void> {
    const started = new Map(ids.map(id => [id, this.local.get(id) ?? 0]))
    try {
      const loaded = await this.deps.repo().quotaBalance.loadFacts(ids, now, monthKey(now))
      for (const id of ids) { this.entries.set(id, { facts: loaded.get(id) ?? EMPTY_FACTS, at: now, localAtLoad: started.get(id) ?? 0 }); this.unavailable.delete(id) }
    } catch (error) {
      warn("quota_facts_refresh_failed", error)
      for (const id of ids) {
        if (!this.entries.has(id) || this.unavailable.has(id)) this.unavailable.add(id)
        this.entries.set(id, { facts: this.entries.get(id)?.facts ?? EMPTY_FACTS, at: now, localAtLoad: started.get(id) ?? 0 })
      }
    }
  }
}

/** The `k` to assume for a member that has not learned its own: the median of the learned ones in the group, else the global default. */
export function kFallbackOf(states: ReadonlyArray<QuotaState | null>): number {
  const learned = states.flatMap(state => state && state.k !== null && state.kSamples >= MIN_K_SAMPLES ? [state.k] : []).sort((a, b) => a - b)
  if (learned.length === 0) return DEFAULT_K_SHARE_PER_USD
  const middle = Math.floor(learned.length / 2)
  return learned.length % 2 === 1 ? learned[middle]! : (learned[middle - 1]! + learned[middle]!) / 2
}

/** Margin on the peers' median k: a seed errs towards "more used". */
export const K_SEED_MARGIN = 1.2
export interface KSeed { k: number; peers: number }
export type KSource = { kind: "own" } | { kind: "peer"; peers: number } | { kind: "default" }

/**
 * D33: a k for a member that has not learned its own, from members of groups of the same owner on the same plan: same latest entitlement, snapshot key and unit form
 * (all known, not unlimited) and a learned k (at least MIN_K_SAMPLES). Max of the peers' k x K_SEED_MARGIN (k is a low quantile and plans mix models, so the highest learned k is the cautious one). Null when the member is unknown, unlimited, or has no such peer.
 */
export function seedKFor(upstreamId: string, plans: readonly MemberPlanFact[]): KSeed | null {
  const me = plans.find(plan => plan.upstreamId === upstreamId)
  if (!me || me.unlimited || me.entitlement === null || me.entitlement <= 0 || me.snapshotKey === null || me.unitForm === null) return null
  const peers = plans.flatMap(plan =>
    plan.upstreamId !== upstreamId && plan.ownerId === me.ownerId && !plan.unlimited && plan.entitlement === me.entitlement
      && plan.snapshotKey === me.snapshotKey && plan.unitForm === me.unitForm && plan.k !== null && Number.isFinite(plan.k) && plan.k > 0 && kLearned(plan) ? [plan.k] : [])
  return peers.length === 0 ? null : { k: Math.max(...peers) * K_SEED_MARGIN, peers: peers.length }
}

/** Where the k behind a member's numbers comes from: its own once learned, else the peer seed, else the fallback (group median / global default). */
export const kSourceOf = (params: Pick<EstimatorParams, "k" | "kSamples">, seed: KSeed | null): KSource =>
  kLearned(params) ? { kind: "own" } : seed ? { kind: "peer", peers: seed.peers } : { kind: "default" }

/**
 * The fallback k of a member (what `effectiveK` uses until its own is learned): the peer seed when there is one, else the group's. `conservative` is for
 * D32's failing estimate: never below the group fallback it used before the seed existed.
 */
export const kFallbackFor = (groupFallback: number, seed: KSeed | null): { kFallback: number; conservative: number } =>
  ({ kFallback: seed?.k ?? groupFallback, conservative: Math.max(groupFallback, seed?.k ?? 0) })

export const paramsOf = (state: QuotaState | null): EstimatorParams => ({ k: state?.k ?? null, kSamples: state?.kSamples ?? 0, o: state?.o ?? 0 })

/** Estimated used share of one member now (from the facts), with the parameters it used. */
export function memberEstimate(facts: MemberFacts | undefined, now: number, kFallback: number): Estimate & { params: EstimatorParams } {
  const state = facts?.state ?? null
  const params = paramsOf(state)
  // A read from the first 30 minutes of the month may still carry last month's numbers: it is not the month base (the month-to-date basis is used until a later read).
  const baseless = state?.lastReadAt != null && state.lastReadAt >= monthStartMs(now) && state.lastReadAt < monthStartMs(now) + MONTH_START_SETTLE_MS
  const estimate = estimateShare({
    lastRead: state && state.lastReadAt !== null ? { at: baseless ? monthStartMs(now) - 1 : state.lastReadAt, share: state.lastReadShare ?? 0, unlimited: state.lastReadUnlimited } : null,
    params, costSinceReadUsd: facts?.costSinceReadUsd ?? 0, monthCostUsd: facts?.monthCostUsd ?? 0, now, kFallback,
  })
  return { ...estimate, params }
}

/**
 * D32: the member's reads keep failing: it has had a successful read (GitHub or manual) at some time but none this month, or its last read failed and is
 * stale (older than two read intervals), and at least one attempt has failed. A member that was NEVER read successfully is not covered (`isNeverReadFailing`):
 * a missing read must not look like 0 %, so it stays ineligible for new sessions until it is read or calibrated. A member that was never attempted
 * (no failure yet) is not failing either: it waits for its join read (D9).
 */
export function isReadFailing(state: QuotaState | null, now: number): boolean {
  if (!state || state.failures <= 0 || state.lastReadAt === null) return false
  const month = monthStartMs(now)
  if (state.lastReadAt < month) return true
  return now - state.lastReadAt > 2 * state.intervalHours * HOUR_MS
}

/** A member without any successful read whose attempts have failed: not eligible (no data), but flagged for the dashboard and banner (`never_read`). */
export const isNeverReadFailing = (state: QuotaState | null): boolean => state !== null && state.lastReadAt === null && state.failures > 0

/**
 * D32: the estimate of a member whose reads keep failing. It errs high: k is the larger of the group's learned fallback k and the global default
 * (never the member's own, possibly low, k), the member's last known outside rate `o` is included, and a member with no read this month starts at
 * the month's gateway cost. The hard line may rest on it (a provisional cut-off) because no real read protects the member.
 */
export function failingEstimate(facts: MemberFacts | undefined, now: number, kFallback: number): { usedShare: number; params: EstimatorParams } {
  const state = facts?.state ?? null
  const params: EstimatorParams = { k: Math.max(kFallback, DEFAULT_K_SHARE_PER_USD), kSamples: MIN_K_SAMPLES, o: state?.o ?? 0 }
  const baseless = state?.lastReadAt == null || state.lastReadAt < monthStartMs(now) + MONTH_START_SETTLE_MS
  const estimate = estimateShare({
    lastRead: baseless ? { at: monthStartMs(now) - 1, share: 0, unlimited: false } : { at: state!.lastReadAt!, share: state!.lastReadShare ?? 0, unlimited: false },
    params, costSinceReadUsd: facts?.costSinceReadUsd ?? 0, monthCostUsd: facts?.monthCostUsd ?? 0, now,
  })
  return { usedShare: estimate.usedShare, params }
}

/** Projected share given to a member whose facts are unavailable: far above any real value, so it is ranked last. */
export const UNAVAILABLE_PROJECTED_SHARE = 1e6

/**
 * Selection views (shares only) of the given members. A member in `unavailable` (facts failed to load, none cached) is eligible, below the soft line
 * and ranked last: a storage problem must not take a whole group out of rotation.
 */
export function viewMembers(ids: readonly string[], facts: ReadonlyMap<string, MemberFacts>, settings: Pick<GroupSettings, "burnHorizonHours">, now: number, unavailable: ReadonlySet<string> = new Set(), plans: readonly MemberPlanFact[] = []): MemberView[] {
  const groupFallback = kFallbackOf(ids.map(id => facts.get(id)?.state ?? null))
  return ids.map(id => {
    if (unavailable.has(id)) return { upstreamId: id, known: true, usedShare: 0, projectedShare: UNAVAILABLE_PROJECTED_SHARE, unavailable: true }
    const f = facts.get(id)
    if (isNeverReadFailing(f?.state ?? null)) return { upstreamId: id, known: false, usedShare: 0, projectedShare: 0, neverRead: true }
    const { kFallback, conservative: kConservative } = kFallbackFor(groupFallback, plans.length > 0 ? seedKFor(id, plans) : null)
    const failing = isReadFailing(f?.state ?? null, now) && f?.state?.lastReadUnlimited !== true
    if (failing) {
      const conservative = failingEstimate(f, now, kConservative)
      const projectedShare = projectShare({
        usedShare: conservative.usedShare, params: conservative.params, burnUsdPerHour: burnRateUsdPerHour(f?.burnBuckets ?? [], now),
        burnHorizonHours: settings.burnHorizonHours, now, kFallback: conservative.params.k ?? DEFAULT_K_SHARE_PER_USD,
      })
      return { upstreamId: id, known: true, usedShare: conservative.usedShare, projectedShare, readFailing: true }
    }
    const estimate = memberEstimate(f, now, kFallback)
    const projectedShare = projectShare({
      usedShare: estimate.usedShare, params: estimate.params, burnUsdPerHour: burnRateUsdPerHour(f?.burnBuckets ?? [], now),
      burnHorizonHours: settings.burnHorizonHours, now, kFallback, unlimited: estimate.unlimited,
    })
    return { upstreamId: id, known: estimate.known, usedShare: estimate.usedShare, projectedShare }
  })
}
