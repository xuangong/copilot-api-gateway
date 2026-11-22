// packages/gateway/src/quota-balance/cutoff.ts
import type { NewPause, PauseReason, PauseRecord } from "../repo/protection.ts"
import type { UpstreamId } from "../repo/branded-ids.ts"
import { getProtection, type ProtectionRuntime } from "../protection/runtime.ts"
import type { QuotaDeps } from "./deps.ts"
import { MONTH_START_SETTLE_MS, provisionalCutoffAllowed } from "./read-schedule.ts"
import { monthStartMs, nextMonthStartMs } from "./time.ts"

export interface CutoffInput {
  upstreamId: string
  groupId: string
  groupName: string
  hardShare: number
  /** Used share: the real read's, or the estimate's. */
  share: number
  source: "real" | "estimate"
  /** Whether k is learned (`estimateShare(...).kLearned`); an estimate cut-off is refused otherwise. */
  kLearned?: boolean
  /** The real read's time (required for a real read); for an estimate the last real read's time, or null (limits how far back an owner resume counts). */
  readAt: number | null
}
export type CutoffResult = "cut" | "lifted" | "none"

const ZERO_COUNTS = { rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }

/**
 * The hard line: a member at or above `hardShare` gets a protection pause (reason `quota`) that ends at the next 00:00 UTC on the 1st,
 * so routing skips it like any paused upstream and the member returns at the reset by expiry. A real read below the line resolves the pause;
 * the estimate may cut provisionally but never lifts. An owner resume holds back any cut-off from a read taken before it until a later real read is at the line again.
 * Every sweep may re-apply the last real share: that is idempotent (an existing quota pause is kept, a resumed one stays resumed).
 */
export class QuotaCutoff {
  constructor(private readonly deps: QuotaDeps, private readonly protection: () => ProtectionRuntime = getProtection) {}

  /** `snapshot`: the active pauses already loaded by the caller (one load per sweep instead of one per member). */
  async activeQuotaPause(upstreamId: string, snapshot?: readonly PauseRecord[]): Promise<PauseRecord | null> {
    const rows = snapshot ?? await this.deps.repo().protection.listActive(this.deps.now())
    return rows.find(row => row.mode === "pause" && row.targetKind === "upstream" && row.targetId === upstreamId && row.reason.trigger === "quota") ?? null
  }

  async apply(input: CutoffInput, pauses?: readonly PauseRecord[]): Promise<CutoffResult> {
    if (input.source === "real" && (typeof input.readAt !== "number" || !Number.isFinite(input.readAt))) throw new Error("QuotaCutoff.apply: a real read needs readAt")
    // With the fallback k the estimate may order members and ask for a read, but must not cut a member off, and never lifts.
    if (input.source === "estimate" && !provisionalCutoffAllowed({ kLearned: input.kLearned === true, estimatedShare: input.share, unlimited: false, settings: { hardShare: input.hardShare } })) return "none"
    const protection = this.protection()
    const active = await this.activeQuotaPause(input.upstreamId, pauses)
    if (input.share < input.hardShare) {
      if (active && input.source === "real") { await protection.resume(active.id, "auto"); return "lifted" }
      return "none"
    }
    // Real reads taken in the first 30 minutes after the reset may still carry last month's numbers: they never cut (estimates already use the month-to-date basis).
    if (input.source === "real" && (input.readAt as number) < monthStartMs(this.deps.now()) + MONTH_START_SETTLE_MS) return "none"
    if (active) {
      // A real read confirms a provisional cut-off: the row is updated in place. Anything else is already cut off.
      if (input.source === "real" && active.reason.quota?.provisional) {
        const reason: PauseReason = { ...active.reason, quota: { groupId: input.groupId, groupName: input.groupName, share: input.share, hardShare: input.hardShare, source: "real", provisional: false } }
        return (await protection.updateReason(active.id, reason)) ? "cut" : "none"
      }
      return "none"
    }
    // An owner resume holds back every cut-off based on a read (or estimate) taken before it; only a later real read cuts again.
    if ((await this.deps.repo().protection.lastOwnerResolvedQuotaAt(input.upstreamId, (input.readAt ?? 0) + 1)) !== null) return "none"
    const now = this.deps.now()
    let upstreamName: string | undefined
    try { upstreamName = (await this.deps.repo().upstreams.getById(input.upstreamId as UpstreamId))?.name } catch { /* optional */ }
    const reason: PauseReason = {
      windowMinutes: 0, requests: 0, risky: 0, counts: ZERO_COUNTS, failureRatio: 0, topKeys: [], trigger: "quota", keyShare: null,
      ...(upstreamName ? { upstreamName, targetName: upstreamName } : {}),
      quota: { groupId: input.groupId, groupName: input.groupName, share: input.share, hardShare: input.hardShare, source: input.source, provisional: input.source === "estimate" },
    }
    const pause: NewPause = {
      id: `pp_${crypto.randomUUID().replace(/-/g, "")}`, targetKind: "upstream", targetId: input.upstreamId, upstreamId: input.upstreamId, mode: "pause",
      reason, startedAt: now, endsAt: nextMonthStartMs(now),
    }
    return (await protection.insertExternal(pause)) ? "cut" : "none"
  }
}
