import { useId } from "react"
import type { CheckStatus, TelemetryBudget, TelemetrySettings, TelemetrySummary, TelemetryTop, TelemetryUnit } from "../../api/telemetry"
import { useT } from "../../state/i18n"
import { Badge } from "../../ui/badge"
import { Card, SectionHeading } from "../../ui/card"
import { cn } from "../../ui/cn"
import { Meter } from "../../ui/meter"
import { Notice } from "../../ui/notice"
import { Table, TBody, Td, Th } from "../../ui/table"
import {
  type DisplayStatus, CHECK_SENTENCE_KEYS, STATUS_KEYS, budgetView, displayStatus, formatUtc, dimsLabel, formatChange, formatShare, formatValue, freshnessNotices, groupLabel, hourRange, hourShort, isLatencyMetric, statusTone,
} from "./telemetry-format"

const money = (value: number | null) => value === null ? "—" : `$${value.toFixed(2)}`

export function FreshnessPanel({ summary, failed = false }: { summary: TelemetrySummary | null; failed?: boolean }) {
  const t = useT()
  const titleId = useId()
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmFreshness")}</SectionHeading>
    {summary === null ? <p className="text-body text-fg-subtle">{t(failed ? "dash.tlmLoadError" : "dash.loadingShort")}</p> : <>
      <p className="text-body text-fg-muted">
        {summary.freshness.lastPushAt ? t("dash.tlmLastPush", { at: formatUtc(summary.freshness.lastPushAt) }) : t("dash.tlmNeverPushed")}
      </p>
      {freshnessNotices(summary).map(notice => notice.kind === "stale"
        ? <Notice key="stale" tone="warn" role="status">{t("dash.tlmStaleWarning", { n: notice.hours })}</Notice>
        : <Notice key={`no-check-${notice.metric}`} tone="warn" role="status">{t("dash.tlmNoCheckWarning", { range: hourRange(notice.hour) })}</Notice>)}
      {summary.checks.map(check => <p key={check.metric} className="flex flex-wrap items-center gap-2 text-body text-fg-muted">
        <Badge tone={statusTone(check.status)}>{t(STATUS_KEYS[check.status])}</Badge>
        <span>{t(CHECK_SENTENCE_KEYS[check.status], { range: hourRange(check.hour) })}{check.status === "failed" && check.stage ? ` ${t("dash.tlmCheckStage", { stage: check.stage })}` : ""}</span>
      </p>)}
    </>}
  </Card>
}

export function BudgetPanel({ budget }: { budget: TelemetryBudget | null }) {
  const t = useT()
  const titleId = useId()
  const view = budget ? budgetView(budget) : null
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmBudget")}</SectionHeading>
    {budget === null || view === null ? <p className="text-body text-fg-subtle">{t("dash.tlmBudgetUnset")}</p> : <>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-body text-fg-muted">
        <span>{t("dash.tlmMtd")}: <b className="text-fg">{formatValue(budget.mtd, budget.unit)}</b></span>
        <span>{t("dash.tlmProjection")}: <b className="text-fg">{formatValue(budget.projection, budget.unit)}</b></span>
        {budget.monthlyLimit !== null ? <span>{t("dash.tlmMonthlyLimit")}: <b className="text-fg">{formatValue(budget.monthlyLimit, budget.unit)}</b></span> : null}
      </div>
      {view.percent !== null ? <>
        <Meter percent={view.percent} tone={view.tone} />
        <p className="text-xs text-fg-subtle">{t("dash.tlmPercentOfLimit", { p: view.percent.toFixed(1) })}</p>
      </> : null}
      {view.over && budget.projectionPercent !== null ? <Notice tone="danger">{t("dash.tlmOverLimit", { p: budget.projectionPercent.toFixed(0) })}</Notice> : null}
      {budget.cost ? <p className="text-body text-fg-muted">{t("dash.tlmCost", { mtd: money(budget.cost.mtd), projection: money(budget.cost.projection) })}</p> : null}
    </>}
  </Card>
}

/** Bar per status: checks are full height, hours without a check to judge are a short baseline tick. */
const BAR_CLASS: Record<DisplayStatus, string> = {
  passed: "h-full bg-success/80",
  failed: "h-full bg-danger",
  "no check": "h-full bg-warn [background-image:repeating-linear-gradient(135deg,transparent_0_3px,rgb(0_0_0/0.18)_3px_5px)]",
  "not monitored": "h-1 bg-fg-subtle/25",
  pending: "h-1 bg-fg-subtle/50",
}
const LEGEND_ORDER: DisplayStatus[] = ["passed", "failed", "no check", "not monitored", "pending"]

/** One bar per hour; a check is one point in time, so it is never summarised as a percentage. */
export function CheckStrip({ hours, statuses, stages, nowMs = Date.now() }: { hours: string[]; statuses: CheckStatus[]; stages: Array<string | null>; nowMs?: number }) {
  const t = useT()
  const cells = hours.map((hour, index) => {
    const status = displayStatus(statuses[index] ?? "not monitored", hour, nowMs)
    const stage = stages[index] ?? null
    return { hour, status, stage, label: `${hourShort(hour)} ${t(STATUS_KEYS[status])}${stage ? ` (${stage})` : ""}` }
  })
  const present = new Set(cells.map(cell => cell.status))
  const failed = cells.filter(cell => cell.status === "failed")
  const missing = cells.filter(cell => cell.status === "no check")
  const passed = cells.filter(cell => cell.status === "passed").length
  const gap = hours.length <= 48 ? "2px" : hours.length <= 200 ? "1px" : "0px"
  const list = (items: typeof cells) => items.map(cell => `${hourShort(cell.hour)}${cell.stage ? ` (${cell.stage})` : ""}`).join(", ")
  return <div className="space-y-1.5">
    <div role="list" className="grid h-7 items-end" style={{ gridTemplateColumns: `repeat(${Math.max(hours.length, 1)}, minmax(0, 1fr))`, columnGap: gap }}>
      {cells.map(cell => <span key={cell.hour} role="listitem" aria-label={cell.label} title={cell.label} data-status={cell.status}
        className={cn("block w-full rounded-[2px] transition-opacity hover:opacity-70", BAR_CLASS[cell.status])} />)}
    </div>
    {hours.length > 0 ? <div className="flex justify-between font-mono text-[11px] text-fg-subtle"><span>{hourShort(hours[0]!)}</span><span>{hourShort(hours[hours.length - 1]!)}</span></div> : null}
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pt-0.5">
      <p className="text-xs text-fg-muted">
        {failed.length === 0 && missing.length === 0
          ? (passed > 0 ? t("dash.tlmChecksAllPassed", { n: String(passed) }) : t("dash.tlmChecksNone"))
          : <>
            {failed.length > 0 ? <span className="mr-3"><b className="font-medium text-fg">{t("dash.tlmStatusFailed")}</b>: {list(failed)}</span> : null}
            {missing.length > 0 ? <span><b className="font-medium text-fg">{t("dash.tlmStatusNoCheck")}</b>: {list(missing)}</span> : null}
          </>}
      </p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-subtle">
        {LEGEND_ORDER.filter(status => present.has(status)).map(status => <li key={status} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="flex h-2.5 w-1.5 items-end"><span className={cn("block w-full rounded-[1px]", status === "not monitored" || status === "pending" ? "h-1" : "h-full", BAR_CLASS[status].replace(/\bh-(full|1)\b/, ""))} /></span>{t(STATUS_KEYS[status])}
        </li>)}
      </ul>
    </div>
  </div>
}

export function TopPanel({ top, settings, groupBy, failed = false }: { top: TelemetryTop | null; settings: TelemetrySettings; groupBy: string; failed?: boolean }) {
  const t = useT()
  const titleId = useId()
  const none = t("dash.tlmNoGroup")
  const rows = (top?.rows ?? []).filter(row => row.value !== 0)
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmTop")}</SectionHeading>
    {groupBy === "" ? <p className="text-body text-fg-subtle">{t("dash.tlmTopPick")}</p>
      : top === null ? <p className="text-body text-fg-subtle">{t(failed ? "dash.tlmLoadError" : "dash.loadingShort")}</p>
      : rows.length === 0 && top.otherCurrent <= 0 ? <p className="text-body text-fg-subtle">{t("dash.tlmNoData")}</p>
      : <Table label={t("dash.tlmTop")}>
        <thead><tr><Th>{t("dash.tlmColGroup")}</Th><Th numeric>{t("dash.tlmColValue")}</Th><Th numeric>{t("dash.tlmColShare")}</Th><Th numeric>{t("dash.tlmColChange")}</Th></tr></thead>
        <TBody>
          {rows.map(row => <tr key={row.key}>
            <Td>{groupLabel(settings, groupBy, row.key, none)}</Td><Td numeric>{formatValue(row.value, top.unit)}</Td>
            <Td numeric>{formatShare(row.share)}</Td><Td numeric>{formatChange(row.change)}</Td>
          </tr>)}
          {top.otherCurrent > 0 ? <tr>
            <Td>{t("dash.tlmOtherLabel")}</Td><Td numeric>{formatValue(top.otherCurrent, top.unit)}</Td><Td numeric>{formatShare(top.otherShare)}</Td><Td numeric>—</Td>
          </tr> : null}
        </TBody>
      </Table>}
  </Card>
}

export function FlaggedPanel({ summary, settings, units, failed = false }: { summary: TelemetrySummary | null; settings: TelemetrySettings; units: Record<string, TelemetryUnit>; failed?: boolean }) {
  const t = useT()
  const titleId = useId()
  const surges = summary?.surges ?? []
  const flags = summary?.flags ?? []
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmFlagged")}</SectionHeading>
    {summary === null ? <p className="text-body text-fg-subtle">{t(failed ? "dash.tlmLoadError" : "dash.loadingShort")}</p>
      : surges.length === 0 && flags.length === 0 ? <p className="text-body text-fg-subtle">{t("dash.tlmNoFlags")}</p> : <>
      {surges.length ? <>
        <SectionHeading as="h3">{t("dash.tlmSurges")}</SectionHeading>
        <Table label={t("dash.tlmSurges")}>
          <thead><tr>
            <Th>{t("dash.tlmColHour")}</Th><Th>{t("dash.tlmMetric")}</Th><Th numeric>{t("dash.tlmColValue")}</Th><Th numeric>{t("dash.tlmColBaseline")}</Th>
            <Th numeric>{t("dash.tlmColRatio")}</Th><Th>{t("dash.tlmColContributors")}</Th>
          </tr></thead>
          <TBody>{surges.map(surge => <tr key={`${surge.metric}-${surge.hour}`}>
            <Td>{hourShort(surge.hour)} UTC</Td><Td>{surge.metric}</Td><Td numeric>{formatValue(surge.value, units[surge.metric] ?? null)}</Td>
            <Td numeric>{formatValue(surge.baseline, units[surge.metric] ?? null)}</Td><Td numeric>{surge.ratio === null ? "—" : `×${surge.ratio.toFixed(1)}`}</Td>
            <Td>{surge.contributors.filter(c => c.value !== 0).map(c => `${dimsLabel(settings, c.dims)} (${formatValue(c.value, units[surge.metric] ?? null)})`).join("; ")}</Td>
          </tr>)}</TBody>
        </Table>
      </> : null}
      {flags.length ? <>
        <SectionHeading as="h3">{t("dash.tlmNonZero")}</SectionHeading>
        <Table label={t("dash.tlmNonZero")}>
          <thead><tr><Th>{t("dash.tlmColHour")}</Th><Th>{t("dash.tlmMetric")}</Th><Th numeric>{t("dash.tlmColTotal")}</Th><Th>{t("dash.tlmColBreakdown")}</Th></tr></thead>
          <TBody>{flags.map(flag => <tr key={`${flag.metric}-${flag.hour}`}>
            <Td>{hourShort(flag.hour)} UTC</Td><Td>{flag.metric}</Td><Td numeric>{formatValue(flag.total, units[flag.metric] ?? null)}</Td>
            <Td>{flag.breakdown.filter(entry => entry.value !== 0).map(entry => dimsLabel(settings, entry.dims)).join("; ")}</Td>
          </tr>)}</TBody>
        </Table>
      </> : null}
    </>}
  </Card>
}

/** Says that a latency chart shows only hours whose check passed, or how to get that. Empty for other metrics. */
export function LatencyNote({ metric, check }: { metric: string; check: string | null }) {
  const t = useT()
  if (!isLatencyMetric(metric)) return null
  return <p className="text-xs text-fg-subtle">{check ? t("dash.tlmLatencyPassedOnly") : t("dash.tlmLatencyUnpaired", { check: `${metric.slice(0, -".latency_ms".length)}.ok` })}</p>
}
