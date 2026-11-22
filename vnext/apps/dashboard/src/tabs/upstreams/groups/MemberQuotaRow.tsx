import type { MemberStatus, UpstreamGroup } from "../../../api/upstream-groups"
import { useT } from "../../../state/i18n"
import { barSegments, entitlementChangeText, memberTone, percentText, reasonKey, shareToPercent, sourceLabel, usedOfText } from "../../../state/quota-format"
import { formatUntil } from "../../telemetry/telemetry-format"
import { Badge } from "../../../ui/badge"
import { Button } from "../../../ui/button"
import { cn } from "../../../ui/cn"

const FILL = { brand: "bg-brand", warn: "bg-warn", danger: "bg-danger", muted: "bg-fg-subtle", faint: "bg-fg-subtle/40" } as const
const SHADE = { brand: "bg-brand/40", warn: "bg-warn/40", danger: "bg-danger/40", muted: "bg-fg-subtle/30", faint: "bg-fg-subtle/20" } as const

interface Props {
  member: MemberStatus
  group: Pick<UpstreamGroup, "id" | "settings">
  nowMs: number
  busy: boolean
  readOnly: boolean
  onRefresh: () => void
  onCalibrate: () => void
  onRemove: () => void
}

/** The quota of one group member: the Users page's used / entitlement with a share bar, where the figure comes from, and what the balancer knows about it. */
export function MemberQuotaRow({ member: m, group, nowMs, busy, readOnly, onRefresh, onCalibrate, onRemove }: Props) {
  const t = useT()
  const { softShare, hardShare } = group.settings
  const bar = barSegments(m)
  const tone = m.usedShare === null ? "brand" : memberTone(m.usedShare, softShare, hardShare)
  const used = usedOfText(m)
  const known = m.usedShare !== null
  const details = [
    m.activeSessions > 0 ? t("dash.qbSessions", { n: m.activeSessions }) : null,
    m.outsideShareLastDay !== null ? t("dash.qbOutside", { percent: percentText(m.outsideShareLastDay) }) : null,
    m.lastErrorPoints !== null ? t("dash.qbError", { points: m.lastErrorPoints.toFixed(1) }) : null,
    t("dash.qbInterval", { hours: m.intervalHours }),
    m.k !== null && m.kPrevious !== null ? t("dash.qbKTrend", { k: m.k.toFixed(2), prev: m.kPrevious.toFixed(2) }) : null,
  ].filter((text): text is string => text !== null)
  return (
    <div data-quota-member={m.upstreamId} role="group" aria-label={m.name} className="mt-2 space-y-1.5 border-t border-border pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-fg-muted">{sourceLabel(m, nowMs, t)}</div>
        {!readOnly ? (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onRefresh} disabled={busy} aria-label={t("dash.qbRefreshOf", { name: m.name })}>{busy ? "…" : t("dash.qbRefresh")}</Button>
            <Button variant="ghost" size="sm" onClick={onCalibrate} disabled={busy} aria-label={t("dash.qbCalibrateOf", { name: m.name })}>{t("dash.qbCalibrate")}</Button>
            <Button variant="ghost" size="sm" onClick={onRemove} disabled={busy} aria-label={t("dash.qbRemoveMemberOf", { name: m.name })}>{t("dash.qbRemoveMember")}</Button>
          </div>
        ) : null}
      </div>
      {m.unlimited ? <div className="text-xs text-fg">{t("dash.qbUnlimited")}</div> : m.lastRead === null && !known ? null : (
        <>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="tabular-nums text-fg">
              {known ? `${used ? `${used} ` : ""}(${percentText(m.usedShare)})` : `${percentText(null)} (${t("dash.qbUnknown")})`}
            </span>
            <span className="tabular-nums text-fg-subtle">{t("dash.qbProjected", { percent: percentText(m.projectedShare) })}</span>
          </div>
          {known ? (
            <>
              <div aria-hidden="true" title={t("dash.qbBarLegend")} className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className={cn("absolute inset-y-0 left-0", FILL[tone])} style={{ width: `${bar.read}%` }} />
                <div className={cn("absolute inset-y-0", SHADE[tone])} style={{ left: `${bar.read}%`, width: `${bar.estimated}%` }} />
                <div className="absolute inset-y-0 w-px bg-fg-subtle" style={{ left: `${shareToPercent(softShare)}%` }} />
                <div className="absolute inset-y-0 w-px bg-danger" style={{ left: `${shareToPercent(hardShare)}%` }} />
              </div>
              <div className="text-xs text-fg-subtle">{t("dash.qbMarkers", { soft: percentText(softShare), hard: percentText(hardShare) })}</div>
            </>
          ) : null}
        </>
      )}
      {details.length > 0 ? <div className="text-xs text-fg-subtle">{details.join(" · ")}</div> : null}
      {m.cutOff ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone="danger">{t("dash.qbCutOff", { until: formatUntil(m.cutOff.until, nowMs) })}</Badge>
          {m.cutOff.provisional ? <span className="text-fg-muted">{t("dash.qbCutOffProvisional", { until: formatUntil(m.cutOff.until, nowMs) })}</span> : null}
        </div>
      ) : null}
      {!m.eligibility.eligible && m.eligibility.reason && m.eligibility.reason !== "cut_off" ? <div className="text-xs text-warn-text">{t(reasonKey(m.eligibility.reason))}</div> : null}
      {m.entitlementChange ? <div className="text-xs text-fg-muted">{entitlementChangeText(m.entitlementChange, t, nowMs)}</div> : null}
      {m.readFailing ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone="warn">{t(m.readFailingReason === "never_read" ? "dash.qbNeverRead" : "dash.qbReadFailing")}</Badge>
          <span className="text-fg-muted">{t(m.readFailingReason === "never_read" ? "dash.qbNeverReadHint" : "dash.qbReadFailingHint")}</span>
        </div>
      ) : null}
      {m.lastError ? <div className="text-xs text-danger-text">{t("dash.qbReadFailedWith", { error: m.lastError })}</div> : null}
    </div>
  )
}
