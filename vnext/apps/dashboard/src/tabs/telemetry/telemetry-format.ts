import type { CheckStatus, TelemetryBudget, TelemetryMetricInfo, TelemetrySeries, TelemetrySettings, TelemetrySummary, TelemetryUnit } from "../../api/telemetry"
import type { ChartDataset } from "../../components/TimeSeriesChart"
import { meterTone, type MeterTone } from "../../ui/meter"

export type RangeId = "24h" | "7d" | "30d"
export const RANGE_HOURS: Record<RangeId, number> = { "24h": 24, "7d": 168, "30d": 720 }
/** A check status as drawn: the hour still open and without a check yet is `pending`, not a warning. */
export type DisplayStatus = CheckStatus | "pending"
export const STATUS_KEYS: Record<DisplayStatus, string> = {
  passed: "dash.tlmStatusPassed", failed: "dash.tlmStatusFailed", "no check": "dash.tlmStatusNoCheck", "not monitored": "dash.tlmStatusNotMonitored",
  pending: "dash.tlmStatusPending",
}
/** A text cue per state, so a marker never relies on colour alone. */

/** The hour containing `nowMs` has not closed: without a check it is pending; a check that already ran in it still counts. */
export function displayStatus(status: CheckStatus, hour: string, nowMs: number): DisplayStatus {
  return status === "no check" && Date.parse(hour) + 3_600_000 > nowMs ? "pending" : status
}

/** An instant as UTC text, e.g. `2026-11-16 09:05 UTC`. */
export const formatUtc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
export const CHECK_SENTENCE_KEYS: Record<CheckStatus, string> = {
  passed: "dash.tlmCheckPassed", failed: "dash.tlmCheckFailed", "no check": "dash.tlmCheckNoCheck", "not monitored": "dash.tlmCheckNotMonitored",
}

const trim = (value: number) => String(parseFloat(value.toFixed(2)))
const grouped = (value: number) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
const LATENCY_SUFFIX = ".latency_ms"
const pad = (value: number) => String(value).padStart(2, "0")

/** Decimal units (1 KB = 1000 B), matching the cost conversion. */
export function formatValue(value: number, unit: TelemetryUnit | null): string {
  if (unit === "bytes") {
    const steps = ["B", "KB", "MB", "GB", "TB", "PB"]
    let scaled = Math.abs(value)
    let index = 0
    while (scaled >= 1000 && index < steps.length - 1) { scaled /= 1000; index++ }
    return `${value < 0 ? "-" : ""}${trim(scaled)} ${steps[index]}`
  }
  if (unit === "ms") return value >= 1000 ? `${trim(value / 1000)} s` : `${trim(value)} ms`
  return Number.isInteger(value) ? grouped(value) : trim(value)
}

export function formatChange(change: number | null): string {
  if (change === null) return "—"
  const percent = Math.round(change * 100)
  return `${percent > 0 ? "+" : ""}${percent}%`
}

export const formatShare = (share: number): string => `${(share * 100).toFixed(1)}%`

/** The owner's name for a dim value, the raw value when there is none, and `noneLabel` for the empty group. */
export function groupLabel(settings: TelemetrySettings, dimKey: string, value: string, noneLabel: string): string {
  if (value === "") return noneLabel
  return settings.labels?.[dimKey]?.[value] ?? value
}

export function dimsLabel(settings: TelemetrySettings, dims: Record<string, string>): string {
  return Object.keys(dims).sort().map(key => `${key}=${groupLabel(settings, key, dims[key]!, "")}`).join(", ")
}

export function hourRange(iso: string): string {
  const start = new Date(iso)
  const end = new Date(start.getTime() + 3_600_000)
  return `${pad(start.getUTCHours())}:00–${pad(end.getUTCHours())}:00 UTC`
}

export function hourShort(iso: string): string {
  const date = new Date(iso)
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:00`
}

export type FreshnessNotice = { kind: "stale"; hours: number } | { kind: "noCheck"; metric: string; hour: string }

/** The staleness warning and, alongside it, one warning for each check metric whose latest closed hour has no check. */
export function freshnessNotices(summary: Pick<TelemetrySummary, "now" | "freshness" | "checks">): FreshnessNotice[] {
  const notices: FreshnessNotice[] = []
  if (summary.freshness.stale) notices.push({ kind: "stale", hours: summary.freshness.hoursSincePush ?? 0 })
  const nowMs = Date.parse(summary.now)
  for (const check of summary.checks) if (check.status === "no check" && Date.parse(check.hour) + 3_600_000 <= nowMs) notices.push({ kind: "noCheck", metric: check.metric, hour: check.hour })
  return notices
}

export type StatusTone = "success" | "danger" | "warn" | "neutral"
export const statusTone = (status: DisplayStatus): StatusTone =>
  status === "passed" ? "success" : status === "failed" ? "danger" : status === "no check" ? "warn" : "neutral"

export interface BudgetView { percent: number | null; tone: MeterTone; over: boolean }

export function budgetView(budget: TelemetryBudget): BudgetView {
  const over = budget.overLimit === true
  const percent = budget.mtdPercent
  return { percent, over, tone: over ? "danger" : percent === null ? "brand" : meterTone(percent) }
}

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z")

/** `to` is the end of the current hour, so the (partial) current hour is included. */
export function rangeWindow(range: RangeId, nowMs: number): { from: string; to: string } {
  const to = Math.floor(nowMs / 3_600_000) * 3_600_000 + 3_600_000
  return { from: iso(to - RANGE_HOURS[range] * 3_600_000), to: iso(to) }
}

/** The traffic chart's range: a preset, or whole UTC days the owner picks. */
export type ChartRange = RangeId | "custom"
export const MAX_CUSTOM_DAYS = 90
const DAY_MS = 86_400_000
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Today's UTC date as YYYY-MM-DD. */
export const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
/** The default custom period: the first of this UTC month through today. */
export const defaultCustomDates = (nowMs: number): { start: string; end: string } => ({ start: `${utcDate(nowMs).slice(0, 8)}01`, end: utcDate(nowMs) })

/**
 * Whole UTC days from `start` through `end`, both included. The window stops at the end of the current hour, so
 * today counts up to now. Errors: a missing or malformed date, end before start, a start in the future, or more than 90 days.
 */
export function customWindow(start: string, end: string, nowMs: number): { from: string; to: string } | { error: "invalid" | "order" | "too_long" } {
  if (!DATE.test(start) || !DATE.test(end)) return { error: "invalid" }
  const from = Date.parse(`${start}T00:00:00Z`)
  const endDay = Date.parse(`${end}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(endDay)) return { error: "invalid" }
  if (endDay < from) return { error: "order" }
  if ((endDay - from) / DAY_MS + 1 > MAX_CUSTOM_DAYS) return { error: "too_long" }
  const nowEnd = Math.floor(nowMs / 3_600_000) * 3_600_000 + 3_600_000
  const to = Math.min(endDay + DAY_MS, nowEnd)
  if (to <= from) return { error: "order" }
  return { from: iso(from), to: iso(to) }
}

/** The sum over the window, skipping gaps; null for `ms` metrics, whose sum means nothing. */
export function windowTotal(series: TelemetrySeries): number | null {
  if (series.unit === "ms") return null
  return series.total.reduce((sum, value) => Number.isFinite(value) ? sum + value : sum, 0)
}

export function defaultMetric(metrics: readonly TelemetryMetricInfo[], settings: TelemetrySettings): string {
  if (settings.budgetMetric && metrics.some(info => info.metric === settings.budgetMetric)) return settings.budgetMetric
  const checks = settings.checkMetrics ?? []
  return (metrics.find(info => !isAvailabilityMetric(info.metric, checks)) ?? metrics[0])?.metric ?? ""
}

/** The namespace a check metric belongs to: `probe.ok` → `probe.`; a metric without a dot is its own namespace. */
const checkNamespace = (check: string): string => check.includes(".") ? check.slice(0, check.lastIndexOf(".") + 1) : check

/** Metrics shown in the availability panel: every check metric and the other metrics of its namespace (e.g. `probe.fail`, `probe.latency_ms`). */
export function isAvailabilityMetric(metric: string, checkMetrics: readonly string[]): boolean {
  return checkMetrics.some(check => metric === check || (check.includes(".") && metric.startsWith(checkNamespace(check))))
}

export interface AvailabilityGroup { check: string; latency: string | null }

/** One group per configured check metric that has data, with its `<namespace>latency_ms` metric when present. */
export function availabilityGroups(metrics: readonly TelemetryMetricInfo[], checkMetrics: readonly string[]): AvailabilityGroup[] {
  const known = new Set(metrics.map(info => info.metric))
  return checkMetrics.filter(check => known.has(check)).map(check => {
    const latency = check.includes(".") ? `${checkNamespace(check)}latency_ms` : null
    return { check, latency: latency !== null && known.has(latency) ? latency : null }
  })
}

export interface ChartInput {
  series: TelemetrySeries
  settings: TelemetrySettings
  groupBy: string
  palette: readonly string[]
  totalLabel: string
  otherLabel: string
  noneLabel: string
  surgeHours: ReadonlySet<string>
}

/** Groups whose total is 0 (e.g. a `probe.fail` group written as 0 by successful probes) carry nothing and are hidden. */
export function visibleGroups<T extends { values: readonly number[] }>(groups: readonly T[]): T[] {
  return groups.filter(group => group.values.some(value => value !== 0 && !Number.isNaN(value)))
}

/** `<name>.latency_ms` is only meaningful in hours whose `<name>.ok` check passed; null when no such check metric is configured. */
export function latencyCheckMetric(metric: string, checkMetrics: readonly string[]): string | null {
  if (!metric.endsWith(LATENCY_SUFFIX)) return null
  const check = `${metric.slice(0, -LATENCY_SUFFIX.length)}.ok`
  return checkMetrics.includes(check) ? check : null
}
export const isLatencyMetric = (metric: string): boolean => metric.endsWith(LATENCY_SUFFIX)

/** A stale latency may remain in an hour whose check later failed: every hour that is not `passed` becomes a gap (NaN); the open hour without a check is a gap too, not a failure. */
export function maskUnpassed(series: TelemetrySeries, check: { hours: readonly string[]; statuses: readonly CheckStatus[] }): TelemetrySeries {
  const passed = new Set(check.hours.filter((_, index) => check.statuses[index] === "passed"))
  const keep = (values: number[]) => values.map((value, index) => passed.has(series.hours[index]!) ? value : Number.NaN)
  return { ...series, total: keep(series.total), groups: series.groups.map(group => ({ ...group, values: keep(group.values) })) }
}

/** One line per group plus a dashed total; without groups the total is the single filled line. */
export function chartFromSeries(input: ChartInput): { labels: string[]; datasets: ChartDataset[] } {
  const { series, palette } = input
  const labels = series.hours.map(hourShort)
  const highlight = series.hours.map(hour => input.surgeHours.has(hour))
  const flagged = highlight.some(Boolean) ? { highlight } : {}
  const groups = visibleGroups(series.groups)
  if (groups.length === 0) {
    return { labels, datasets: [{ label: input.totalLabel, data: series.total, color: palette[0] ?? "#4E6CF5", fill: true, ...flagged }] }
  }
  const lines: ChartDataset[] = groups.map((group, index) => ({
    label: group.key === "(other)" ? input.otherLabel : groupLabel(input.settings, input.groupBy, group.key, input.noneLabel),
    data: group.values, color: group.key === "(other)" ? "#8a8a8a" : palette[index % palette.length] ?? "#4E6CF5", fill: false,
  }))
  lines.push({ label: input.totalLabel, data: series.total, color: "#6b7280", dashed: true, fill: false, ...flagged })
  return { labels, datasets: lines }
}

/** Metrics with a built-in explanation (the trojan agent's); other sources' metrics have none. */
const DESCRIBED_METRICS = new Set(["nic.total_bytes", "nic.tx_bytes", "nic.rx_bytes", "proxy.sent_bytes", "proxy.recv_bytes", "proxy.connections", "probe.ok", "probe.fail", "probe.latency_ms"])
/** The i18n key explaining why a metric matters, or null when it has none. */
export const metricDescriptionKey = (metric: string): string | null => DESCRIBED_METRICS.has(metric) ? `dash.tlmAbout.${metric}` : null
