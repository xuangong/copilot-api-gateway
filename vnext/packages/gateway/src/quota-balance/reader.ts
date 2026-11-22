// packages/gateway/src/quota-balance/reader.ts
import { fetchCopilotUser } from "@vibe-llm/provider-copilot/github"
import type { Fetcher } from "@vibe-core/upstream"
import type { UpstreamId } from "../repo/branded-ids.ts"
import type { PauseRecord } from "../repo/protection.ts"
import type { QuotaRead, QuotaState, UpstreamGroup } from "../repo/quota-balance.ts"
import { copilotCredentialOf } from "./credential.ts"
import type { QuotaCutoff } from "./cutoff.ts"
import { warn, type QuotaDeps } from "./deps.ts"
import type { GroupDirectoryCache } from "./directory.ts"
import { K_WINDOW_MS, learn, type ReadPoint } from "./estimator.ts"
import { failingEstimate, isReadFailing, kFallbackFor, kFallbackOf, memberEstimate, paramsOf, seedKFor, type MemberFactsCache } from "./facts.ts"
import {
  MANUAL_MIN_READ_GAP_MS, MIN_INTERVAL_HOURS, backoffHours, nextIntervalHours, readAllowedAt, readDecision, readFloorMs, scheduleNextRead, type ReadReason, type SchedState,
} from "./read-schedule.ts"
import { parseQuotaSnapshot, type ParsedQuota } from "./snapshot.ts"
import { HOUR_MS, MINUTE_MS, monthStartMs } from "./time.ts"
import { MONTH_START_SETTLE_MS as SETTLE_MS } from "./read-schedule.ts"

const READ_TIMEOUT_MS = 15_000
const CALIBRATION_WINDOW_MS = 24 * HOUR_MS
const MAX_CALIBRATED_SHARE = 1.5

export class CalibrationError extends Error {}

export type ReadOutcome =
  | { status: "read"; read: QuotaRead }
  | { status: "floor"; reason: ReadReason | null; blockedUntil: number }
  | { status: "error"; error: string }
  | { status: "unsupported"; error: string }
  | { status: "idle" }

export interface ReaderParts {
  directory: GroupDirectoryCache
  facts: MemberFactsCache
  cutoff: QuotaCutoff
  /** The member's own egress: its saved proxy chain (the path the Users page uses), or plain fetch. */
  fetcherFor: (upstreamId: string) => Promise<Fetcher>
  /** Defaults to 15 s. */
  timeoutMs?: number
}

export const schedStateOf = (state: QuotaState): SchedState => ({
  lastReadAt: state.lastReadAt, lastReadShare: state.lastReadShare, lastAttemptAt: state.lastAttemptAt, nextReadAt: state.nextReadAt,
  failures: state.failures, unlimited: state.lastReadUnlimited, dayKey: state.dayKey, dayReads: state.dayReads,
})

/** Runs `work` with an abort signal that fires after `ms`: the request is cancelled, and a fetcher that ignores the signal is still given up on. */
async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")) }, ms) })
  try { return await Promise.race([work(controller.signal), expired]) } finally { clearTimeout(timer) }
}

/** `kFallback`: the peer-seeded k when there is one (D33), else the group's; `kConservative` is what D32's failing estimate uses (never below the group's). */
interface Member { upstreamId: string; group: UpstreamGroup; state: QuotaState; kFallback: number; kConservative: number }

export class QuotaReader {
  private readonly lastEvaluated = new Map<string, number>()
  private readonly calibrations = new Map<string, Promise<void>>()

  constructor(private readonly deps: QuotaDeps, private readonly parts: ReaderParts) {}

  /** The member's group, state and the fallback k, or null when it is not a group member. */
  private async member(upstreamId: string, fresh: boolean): Promise<Member | null> {
    const directory = await this.parts.directory.get()
    const groupId = directory.memberOf.get(upstreamId)
    const group = groupId ? directory.groups.get(groupId) : undefined
    if (!group) return null
    const siblings = [...directory.memberOf].flatMap(([id, g]) => g === group.id ? [id] : [])
    const all = await this.parts.facts.get(siblings, { fresh })
    const state = all.get(upstreamId)?.state
    if (!state) return null
    const seed = seedKFor(upstreamId, await this.parts.facts.plans({ fresh }))
    const { kFallback, conservative } = kFallbackFor(kFallbackOf(siblings.map(id => all.get(id)?.state ?? null)), seed)
    return { upstreamId, group, state, kFallback, kConservative: conservative }
  }

  /**
   * One GitHub read (floors enforced here, whoever asks). The result becomes the estimator's base, `k`/`o` are re-learned, the next read
   * is scheduled and the hard line is applied.
   */
  async readNow(upstreamId: string, options: { reason: ReadReason; manual: boolean; pauses?: readonly PauseRecord[] }): Promise<ReadOutcome> {
    const now = this.deps.now()
    const upstream = await this.deps.repo().upstreams.getById(upstreamId as UpstreamId)
    const credential = copilotCredentialOf(upstream)
    if (!credential) return { status: "unsupported", error: "not a Copilot upstream with a stored GitHub credential" }
    const member = await this.member(upstreamId, true)
    if (!member) return { status: "unsupported", error: "not a group member" }
    const allowedAt = readAllowedAt(schedStateOf(member.state), member.group.settings, options.manual, now)
    if (now < allowedAt) return { status: "floor", reason: options.reason, blockedUntil: allowedAt }
    const floorMs = readFloorMs(member.state, member.group.settings, options.manual)
    // Claim the read before any request leaves: concurrent callers (other isolates, a page open and the sweep) cannot both get through the floor.
    if (!(await this.deps.repo().quotaBalance.claimRead(upstreamId, now, floorMs, { intervalHours: member.group.settings.readIntervalHours, manual: options.manual }))) {
      return { status: "floor", reason: options.reason, blockedUntil: now + floorMs }
    }

    let parsed: ParsedQuota | null = null
    let failure: string | null
    try {
      const fetcher = await this.parts.fetcherFor(upstreamId)
      const outcome = await withTimeout(async signal => {
        const response = await fetchCopilotUser(credential.token, credential.host, (input, init) => fetcher(input, { ...init, signal }))
        if (!response.ok) {
          await response.body?.cancel().catch(() => {}) // the body is never read (it could carry anything)
          return { failure: `HTTP ${response.status}`, parsed: null }
        }
        const body = parseQuotaSnapshot(await response.json().catch(() => null))
        return body ? { failure: null, parsed: body } : { failure: "unreadable quota response", parsed: null }
      }, this.parts.timeoutMs ?? READ_TIMEOUT_MS)
      failure = outcome.failure
      parsed = outcome.parsed
    } catch (error) { failure = error instanceof Error ? (error.message === "timeout" ? "timeout" : error.name) : "error" }
    if (failure !== null || parsed === null) {
      const next = now + backoffHours(member.state.failures + 1, member.group.settings.readIntervalHours) * HOUR_MS
      await this.deps.repo().quotaBalance.recordFailure(upstreamId, now, next, failure ?? "error")
      this.parts.facts.invalidate(upstreamId)
      return { status: "error", error: failure ?? "error" }
    }
    const read = await this.finish(member, options.pauses, { at: now, source: "github", used: parsed.used, entitlement: parsed.entitlement, unlimited: parsed.unlimited, snapshotKey: parsed.key, unitForm: parsed.unitForm, resetAt: parsed.resetAt, costAdjustUsd: 0 })
    return { status: "read", read }
  }

  /**
   * Owner-entered used / entitlement (or used share) as of `at` (default now; at most 24 h back, within the current month after its first 30 minutes; up to a
   * minute of clock skew into the future is clamped to now), stored as a manual read. It has its own floor, 10 minutes since the last calibration: a failed
   * read or a page-open attempt does not block it. Calibrations of one member in this isolate are serialised.
   */
  calibrate(upstreamId: string, input: { used?: number; entitlement?: number; usedShare?: number; at?: number }): Promise<ReadOutcome> {
    const previous = this.calibrations.get(upstreamId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(() => this.calibrateOnce(upstreamId, input))
    const tail = run.then(() => {}, () => {})
    this.calibrations.set(upstreamId, tail)
    void tail.then(() => { if (this.calibrations.get(upstreamId) === tail) this.calibrations.delete(upstreamId) })
    return run
  }

  private async calibrateOnce(upstreamId: string, input: { used?: number; entitlement?: number; usedShare?: number; at?: number }): Promise<ReadOutcome> {
    const now = this.deps.now()
    const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
    let at = input.at ?? now
    const floorAt = (await this.deps.repo().quotaBalance.getStates([upstreamId])).get(upstreamId)?.lastCalibrationAt
    if (floorAt != null && now < floorAt + MANUAL_MIN_READ_GAP_MS) return { status: "floor", reason: "manual", blockedUntil: floorAt + MANUAL_MIN_READ_GAP_MS }
    if (!num(at) || at > now + MINUTE_MS || now - at > CALIBRATION_WINDOW_MS) throw new CalibrationError("at must be within the last 24 hours")
    at = Math.min(at, now)
    if (at < monthStartMs(now) + SETTLE_MS) throw new CalibrationError("at must be in the current month, after its first 30 minutes")
    const member = await this.member(upstreamId, true)
    if (!member) return { status: "unsupported", error: "not a group member" }
    const entitlement = input.entitlement !== undefined ? input.entitlement : member.state.entitlement ?? 100
    if (!num(entitlement) || entitlement <= 0) throw new CalibrationError("entitlement must be a positive number")
    const used = input.used !== undefined ? input.used : input.usedShare !== undefined ? input.usedShare * entitlement : undefined
    if (used === undefined || !num(used) || used < 0) throw new CalibrationError("used must be a number of at least 0")
    if (used > MAX_CALIBRATED_SHARE * entitlement) throw new CalibrationError("used must not exceed 1.5 times the entitlement")
    if (member.state.lastReadAt !== null && at <= member.state.lastReadAt) throw new CalibrationError("at must be after the last read")
    const claim = await this.deps.repo().quotaBalance.claimCalibration(upstreamId, now, MANUAL_MIN_READ_GAP_MS)
    if (!claim.claimed) return { status: "floor", reason: "manual", blockedUntil: claim.blockedUntil }
    const costAdjustUsd = now - at > 10 * MINUTE_MS ? await this.deps.repo().quotaBalance.costBetween(upstreamId, at, now) : 0
    const read = await this.finish(member, undefined, { at, source: "manual", used, entitlement, unlimited: false, snapshotKey: null, unitForm: null, resetAt: null, costAdjustUsd })
    return { status: "read", read }
  }

  private async finish(member: Member, pauses: readonly PauseRecord[] | undefined, value: { at: number; source: "github" | "manual"; used: number; entitlement: number; unlimited: boolean; snapshotKey: string | null; unitForm: string | null; resetAt: string | null; costAdjustUsd: number }): Promise<QuotaRead> {
    const now = this.deps.now()
    const repo = this.deps.repo().quotaBalance
    const { state, group } = member
    const facts = (await this.parts.facts.get([member.upstreamId])).get(member.upstreamId)
    const estimate = memberEstimate(facts, now, member.kFallback)
    const estimatedShareBefore = estimate.known && !estimate.unlimited ? estimate.usedShare : null
    const share = value.unlimited || value.entitlement <= 0 ? 0 : value.used / value.entitlement
    const change = !value.unlimited && state.entitlement !== null && state.entitlement > 0 && Math.abs(state.entitlement - value.entitlement) > 1e-6 * Math.max(state.entitlement, value.entitlement)
      ? { from: state.entitlement, to: value.entitlement } : null
    const errorPoints = estimatedShareBefore === null || change ? null : (estimatedShareBefore - share) * 100
    const read = await repo.recordRead({
      upstreamId: member.upstreamId, at: value.at, source: value.source, used: value.used, entitlement: value.entitlement, unlimited: value.unlimited,
      estimatedShareBefore, errorPoints, snapshotKey: value.snapshotKey, unitForm: value.unitForm, resetAt: value.resetAt, costAdjustUsd: value.costAdjustUsd, entitlementChange: change,
    }, now)
    const history = await repo.listReads(member.upstreamId, value.at - K_WINDOW_MS - 24 * HOUR_MS)
    const points: ReadPoint[] = history.map(r => ({ at: r.at, share: r.share, entitlement: r.entitlement, unlimited: r.unlimited, costTotalUsd: r.costTotalUsd, snapshotKey: r.snapshotKey, unitForm: r.unitForm }))
    const newPoint = points.find(point => point.at === read.at)!
    const learned = learn({ prev: paramsOf(state), reads: points, read: newPoint, learnSince: state.learnSince, previousEntitlement: state.entitlement, estimatedShareBefore, kFallback: member.kFallback })
    const intervalHours = learned.entitlementChange ? MIN_INTERVAL_HOURS : nextIntervalHours(state.intervalHours, learned.errorPoints, group.settings.readIntervalHours)
    const kPrev = state.k !== null && learned.k !== null && Math.abs(learned.k - state.k) > 0.01 * state.k ? state.k : state.kPrev
    await repo.saveEstimator(member.upstreamId, {
      k: learned.k, kPrev, kSamples: learned.kSamples, o: learned.o, oSamples: learned.oSamples, intervalHours, learnSince: learned.learnSince,
      nextReadAt: scheduleNextRead(now, intervalHours, this.deps.random), lastErrorPoints: learned.errorPoints,
    }, now)
    this.parts.facts.invalidate(member.upstreamId)
    try {
      await this.parts.cutoff.apply({ upstreamId: member.upstreamId, groupId: group.id, groupName: group.name, hardShare: group.settings.hardShare, share, source: "real", readAt: value.at }, pauses)
    } catch (error) { warn("quota_cutoff_failed", error) }
    return read
  }

  /**
   * One member's turn in the sweep or after a recorded cost: reads when the scheduler says so (join, monthly, scheduled, drift, confirm, soft or hard line),
   * and cuts the member off provisionally when the estimate is at the hard line but the floor blocks the confirming read.
   * `allowScheduled: false` holds back join/monthly/scheduled reads (the sweep staggers those); the early triggers are never held back.
   */
  async evaluateMember(upstreamId: string, options: { allowScheduled: boolean; fresh?: boolean; pauses?: readonly PauseRecord[] }): Promise<ReadOutcome> {
    const now = this.deps.now()
    const member = await this.member(upstreamId, options.fresh ?? true)
    // A disabled group is not balanced, but its members are still read and cut off at the hard line: pinned and direct traffic can reach them.
    if (!member) return { status: "idle" }
    const facts = (await this.parts.facts.get([upstreamId])).get(upstreamId)
    // D32: reads keep failing, so nothing real protects this member: the conservative estimate may cut it off provisionally (under any exhausted policy, k learned or not).
    const failing = isReadFailing(member.state, now) && !member.state.lastReadUnlimited
    const estimate = failing
      ? { known: true, unlimited: false, kLearned: true, usedShare: failingEstimate(facts, now, member.kConservative).usedShare }
      : memberEstimate(facts, now, member.kFallback)
    // The caller's pause snapshot predates anything this call inserts: after a provisional cut-off here it is not used again.
    let pauses = options.pauses
    if (failing && estimate.usedShare >= member.group.settings.hardShare) {
      pauses = undefined
      try {
        await this.parts.cutoff.apply({
          upstreamId, groupId: member.group.id, groupName: member.group.name, hardShare: member.group.settings.hardShare, share: estimate.usedShare, source: "estimate",
          kLearned: true, readAt: member.state.lastReadAt,
        }, options.pauses)
      } catch (error) { warn("quota_cutoff_failed", error) }
    }
    const decision = readDecision({ now, state: schedStateOf(member.state), estimatedShare: estimate.usedShare, settings: member.group.settings })
    if (decision.read && decision.reason !== null) {
      if (!options.allowScheduled && (decision.reason === "scheduled" || decision.reason === "join" || decision.reason === "monthly")) return { status: "idle" }
      return this.readNow(upstreamId, { reason: decision.reason, manual: false, ...(pauses ? { pauses } : {}) })
    }
    try {
      if (decision.reason === "hard" && estimate.known && !estimate.unlimited) {
        // Provisional: the cut-off refuses it unless k is learned (with the fallback k the hard line only asks for the read, floor permitting).
        await this.parts.cutoff.apply({
          upstreamId, groupId: member.group.id, groupName: member.group.name, hardShare: member.group.settings.hardShare, share: estimate.usedShare, source: "estimate",
          kLearned: estimate.kLearned === true, readAt: member.state.lastReadAt,
        }, pauses)
      } else if (!failing && member.state.lastReadAt !== null && member.state.lastReadShare !== null && !member.state.lastReadUnlimited && member.state.lastReadAt >= monthStartMs(now) + SETTLE_MS) {
        // Idempotent re-apply of this month's last real share: restores a lost cut-off, keeps an existing one, respects an owner resume. Never for a member whose reads
        // keep failing (its provisional cut-off rests on the estimate; a stale real share must not lift it) nor with a read from before this month's base.
        await this.parts.cutoff.apply({
          upstreamId, groupId: member.group.id, groupName: member.group.name, hardShare: member.group.settings.hardShare, share: member.state.lastReadShare, source: "real", readAt: member.state.lastReadAt,
        }, pauses)
      }
    } catch (error) { warn("quota_cutoff_failed", error) }
    return { status: "idle" }
  }

  /** From the cost tracker: at most one evaluation per member and minute per isolate. Never throws. */
  async evaluateSoon(upstreamId: string): Promise<void> {
    const now = this.deps.now()
    const last = this.lastEvaluated.get(upstreamId)
    if (last !== undefined && now - last < MINUTE_MS) return
    this.lastEvaluated.set(upstreamId, now)
    try { await this.evaluateMember(upstreamId, { allowScheduled: false, fresh: false }) } catch (error) { warn("quota_evaluate_failed", error) }
  }
}

