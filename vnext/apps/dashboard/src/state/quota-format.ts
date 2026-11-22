import type { IneligibleReason, MemberStatus } from "../api/upstream-groups"
import type { MeterTone } from "../ui/meter"
import { formatInstantMs } from "../tabs/telemetry/telemetry-format"
import { timeAgo } from "./time-ago"

export type Translate = (key: string, vars?: Record<string, string | number>) => string

/** A share as a percent number without float noise (0.45 -> 45, 0.9 -> 90). */
export const shareToPercent = (share: number): number => Math.round(share * 1e8) / 1e6
/** A share as a percent: one decimal below 10 % (judged on the rounded value, so 9.96 % reads "10%", not "10.0%"). */
export const percentText = (share: number | null): string => {
  if (share === null) return "—"
  const percent = share * 100
  return `${Math.round(percent) < 10 ? percent.toFixed(1) : percent.toFixed(0)}%`
}
export const amountText = (value: number): string => Math.round(value).toLocaleString("en-US")
export const usedOfText = (m: MemberStatus): string | null => m.estimatedUsed === null || m.entitlement === null ? null : `${amountText(m.estimatedUsed)} / ${amountText(m.entitlement)}`

/** Solid part: the last read. Shaded part: what the estimator adds on top (gateway cost and outside usage since the read). Percent of the allowance, at most 100 in total. */
export function barSegments(m: MemberStatus): { read: number; estimated: number; total: number } {
  if (m.usedShare === null) return { read: 0, estimated: 0, total: 0 }
  const total = Math.max(0, Math.min(100, shareToPercent(m.usedShare)))
  // Without a read (a known share can still exist, e.g. from gateway cost alone) the whole bar is estimate.
  const read = m.lastRead === null ? 0 : Math.max(0, Math.min(total, shareToPercent(m.lastRead.share)))
  return { read, estimated: Math.round((total - read) * 1e6) / 1e6, total }
}

export const memberTone = (usedShare: number, softShare: number, hardShare: number): MeterTone => usedShare >= hardShare ? "danger" : usedShare >= softShare ? "warn" : "brand"

const ago = (ms: number, nowMs: number): string => timeAgo(new Date(ms).toISOString(), nowMs, "long")

/** "GitHub, live · just now", "estimate · last read 2 hours ago", "calibrated by hand · ..." or the not-read-yet notice. */
export function sourceLabel(m: MemberStatus, nowMs: number, t: Translate): string {
  if (m.lastRead === null) return t(m.usedShare === null ? "dash.qbNoRead" : "dash.qbSourceEstimateOnly")
  const age = ago(m.lastRead.at, nowMs)
  if (m.lastRead.source === "manual") return t("dash.qbSourceManual", { ago: age })
  if (nowMs - m.lastRead.at < 90_000) return t("dash.qbSourceLive")
  const drift = (m.usedShare ?? m.lastRead.share) - m.lastRead.share
  return t(Math.abs(drift) < 0.0005 ? "dash.qbSourceRead" : "dash.qbSourceEstimate", { ago: age })
}

export function entitlementChangeText(change: { from: number; to: number; at: number }, t: Translate, nowMs: number): string {
  return t("dash.qbEntitlementChanged", { from: amountText(change.from), to: amountText(change.to), when: Math.abs(nowMs - change.at) < 30 * 86_400_000 ? ago(change.at, nowMs) : formatInstantMs(change.at) })
}

const REASON_KEYS: Record<IneligibleReason, string> = {
  group_disabled: "dash.qbReasonGroupDisabled", disabled: "dash.qbReasonDisabled", cut_off: "dash.qbReasonCutOff", paused: "dash.qbReasonPaused", no_read: "dash.qbReasonNoRead", soft_line: "dash.qbReasonSoftLine",
}
export const reasonKey = (reason: IneligibleReason): string => REASON_KEYS[reason]
