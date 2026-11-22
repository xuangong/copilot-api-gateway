// apps/dashboard/src/components/protection-banner-model.ts
import type { PauseReason, ProtectionPause } from "../api/protection"
import type { GroupAlert } from "../api/upstream-groups"
import { percentText } from "../state/quota-format"
import { formatUntil } from "../tabs/telemetry/telemetry-format"

export type Translate = (key: string, vars?: Record<string, string | number>) => string
const RISKY = ["rate_limited", "rejected", "auth"] as const
const KIND_KEYS = { rate_limited: "dash.protKindRateLimited", rejected: "dash.protKindRejected", auth: "dash.protKindAuth" } as const

/** "46 rate-limit errors in 5 min (92% of requests)": the dominant risky class, the window and the failure ratio. */
export function summarizeReason(reason: PauseReason, t: Translate): string {
  if (reason.trigger === "quota" && reason.quota) {
    return t(reason.quota.provisional ? "dash.qbPauseSummaryProvisional" : "dash.qbPauseSummary", { percent: percentText(reason.quota.share), hard: percentText(reason.quota.hardShare) })
  }
  const kind = RISKY.reduce((best, cls) => (reason.counts[cls] > reason.counts[best] ? cls : best), RISKY[0])
  return t("dash.protSummary", { count: reason.counts[kind], kind: t(KIND_KEYS[kind]), minutes: reason.windowMinutes, percent: Math.round(reason.failureRatio * 100) })
}

export interface BannerItem {
  id: string
  tone: "danger" | "warn"
  text: string
  /** Only pauses are resumed (a warning just ends), and only by those the server says may resume them. */
  canResume: boolean
  /** Blank when the viewer does not own the upstream. */
  upstreamId: string
  targetKind: "upstream" | "key"
  /** Set for quota group alerts: the group the Open button brings into view on the Upstreams page. */
  groupId?: string
}

/** Pauses first, then warnings; newest first within each. */
export function bannerItems(pauses: readonly ProtectionPause[], t: Translate, nowMs: number): BannerItem[] {
  return [...pauses]
    .sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "pause" ? -1 : 1) || b.startedAt - a.startedAt)
    .map((pause): BannerItem => {
      const vars = { name: pause.targetName, upstream: pause.upstreamName, until: formatUntil(pause.endsAt, nowMs), summary: summarizeReason(pause.reason, t) }
      // A key owner whose key was paused because of someone else's upstream gets no upstream name: word it generically.
      const key = pause.targetKind === "key" ? (pause.upstreamName === "" ? "KeyAnon" : "Key") : "Upstream"
      const text = pause.mode === "pause" ? t(`dash.protBanner${key}Paused`, vars) : t(`dash.protBanner${key}Warning`, vars)
      return { id: pause.id, tone: pause.mode === "pause" ? "danger" : "warn", text, canResume: pause.mode === "pause" && pause.canResume, upstreamId: pause.upstreamId, targetKind: pause.targetKind }
    })
}

/** Banner items for groups that cannot take new sessions (danger), run in overage or have a member whose reads keep failing (warning). They cannot be resumed and have no upstream to open. */
export function groupAlertItems(alerts: readonly GroupAlert[], t: Translate): BannerItem[] {
  return alerts.map((alert): BannerItem => {
    const text = alert.kind === "read_failing" ? t(alert.reason === "never_read" ? "dash.qbBannerNeverRead" : "dash.qbBannerReadFailing", { group: alert.groupName, name: alert.upstreamName })
      : t(alert.kind === "stopped" ? "dash.qbBannerStopped" : "dash.qbBannerOverage", { name: alert.groupName })
    return {
      id: alert.kind === "read_failing" ? `qb:${alert.groupId}:${alert.kind}:${alert.upstreamId}` : `qb:${alert.groupId}:${alert.kind}`,
      tone: alert.kind === "stopped" ? "danger" : "warn", text, canResume: false, upstreamId: "", targetKind: "upstream", groupId: alert.groupId,
    }
  })
}
