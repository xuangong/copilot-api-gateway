import type { CheckStatus, TelemetryBudget, TelemetryDimFilter, TelemetryMetricInfo, TelemetrySeries, TelemetrySettings, TelemetrySummary, TelemetryUnit } from "../../api/telemetry"
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

/**
 * The one time zone every telemetry time is shown in. Data stays in hourly UTC buckets on the server; only display
 * (and the custom date picker) use this zone. Defaults to the browser's zone; tests pin it with `setDisplayZone`.
 */
const browserZone = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } catch { return "UTC" } }
let displayZone: string | null = null
/** Pin the display zone (an IANA name), or pass null to go back to the browser's zone. */
export function setDisplayZone(zone: string | null): void { displayZone = zone }
export const getDisplayZone = (): string => displayZone ?? browserZone()

const formatters = new Map<string, Intl.DateTimeFormat>()
interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number }
/** The wall-clock fields of an instant in the display zone. */
function zoneParts(ms: number, zone = getDisplayZone()): Parts {
  let fmt = formatters.get(zone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    formatters.set(zone, fmt)
  }
  const out: Record<string, number> = {}
  for (const part of fmt.formatToParts(new Date(ms))) if (part.type !== "literal") out[part.type] = Number(part.value)
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour! % 24, minute: out.minute!, second: out.second! }
}
/** The zone's offset from UTC at an instant, in ms (positive east of Greenwich). */
function zoneOffsetMs(ms: number, zone = getDisplayZone()): number {
  const p = zoneParts(ms, zone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}
/** `UTC+8`, `UTC-5`, `UTC+5:30`. */
export function offsetLabel(nowMs: number, zone = getDisplayZone()): string {
  const mins = Math.round(zoneOffsetMs(nowMs, zone) / 60_000)
  const abs = Math.abs(mins)
  const m = abs % 60
  return `UTC${mins < 0 ? "-" : "+"}${Math.floor(abs / 60)}${m === 0 ? "" : `:${pad(m)}`}`
}
/** The zone as named in the note under times: `Asia/Shanghai, UTC+8`. */
export const zoneLabel = (nowMs: number): string => `${getDisplayZone()}, ${offsetLabel(nowMs)}`

/** An instant as zone text, e.g. `2026-11-16 17:05`. */
export const formatInstant = (iso: string): string => {
  if (!Number.isFinite(Date.parse(iso))) return iso
  const p = zoneParts(Date.parse(iso))
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}
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

/** A dim value with the owner's name for it: `#1 (MacBook)`; the bare value when it has no name. */
export function valueWithName(settings: TelemetrySettings, dimKey: string, value: string): string {
  const name = settings.labels?.[dimKey]?.[value]
  return name === undefined || name === value ? value : `${value} (${name})`
}

/** The active filter as shown next to a total: `user #1 (MacBook)`. */
export const filterText = (settings: TelemetrySettings, filter: TelemetryDimFilter): string => `${filter.key} ${valueWithName(settings, filter.key, filter.value)}`

/** The `filter` query param (`key:value`), or undefined without a filter. */
export const filterQuery = (filter: TelemetryDimFilter | null | undefined): string | undefined => filter ? `${filter.key}:${filter.value}` : undefined

/** The dim a metric can be filtered on: needs at least two dims; `user` when it is not the split dim, else the first other dim. Null when none. */
export function filterDimFor(dims: readonly string[], groupBy: string): string | null {
  if (dims.length < 2) return null
  if (dims.includes("user") && groupBy !== "user") return "user"
  return dims.find(dim => dim !== groupBy) ?? null
}

/** The filter that may stay: its dim is still the one offered and, once the values are known, its value is among them. */
export function keepFilter(filter: TelemetryDimFilter | null, filterKey: string | null, values: { key: string; values: readonly string[] } | null): TelemetryDimFilter | null {
  if (filter === null || filterKey === null || filter.key !== filterKey) return null
  if (values !== null && values.key === filterKey && !values.values.includes(filter.value)) return null
  return filter
}

export function dimsLabel(settings: TelemetrySettings, dims: Record<string, string>): string {
  return Object.keys(dims).sort().map(key => `${key}=${groupLabel(settings, key, dims[key]!, "")}`).join(", ")
}

/** An hour bucket as `HH:mm–HH:mm` in the display zone (minutes are 30 or 45 in zones with fractional offsets). */
export function hourRange(iso: string): string {
  const start = Date.parse(iso)
  const clock = (ms: number) => { const p = zoneParts(ms); return `${pad(p.hour)}:${pad(p.minute)}` }
  return `${clock(start)}–${clock(start + 3_600_000)}`
}

/** An instant as `MM-DD HH:mm` in the display zone. */
export function hourShort(iso: string): string {
  const p = zoneParts(Date.parse(iso))
  return `${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
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

/** The traffic chart's range: a preset, or whole local calendar days the owner picks. */
export type ChartRange = RangeId | "custom"
export const MAX_CUSTOM_DAYS = 90
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** The date (YYYY-MM-DD) of an instant in the display zone: "today" for the date picker. */
export const localDate = (ms: number): string => { const p = zoneParts(ms); return `${p.year}-${pad(p.month)}-${pad(p.day)}` }
/** The default custom period: the first of this local month through local today. */
export const defaultCustomDates = (nowMs: number): { start: string; end: string } => ({ start: `${localDate(nowMs).slice(0, 8)}01`, end: localDate(nowMs) })

/** The instant at which the display zone's wall clock reads `date` 00:00 (DST-safe: the offset is looked up, twice, not assumed). */
function localMidnight(date: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`)
  let guess = wall - zoneOffsetMs(wall)
  guess = wall - zoneOffsetMs(guess)
  return guess
}

/**
 * Local calendar days from `start` through `end`, both included: from = local midnight of `start`, to = local midnight
 * after `end`, capped at the end of the current hour (so today counts up to now). The API takes top-of-hour UTC
 * instants, so `from` is floored and `to` ceiled to whole UTC hours; that only moves anything in zones whose offset is
 * not a whole number of hours (e.g. Asia/Kolkata, UTC+5:30), where the window widens by up to 30 or 45 minutes.
 * Errors: a missing or malformed date, end before start, a start in the future, or more than 90 days.
 */
export function customWindow(start: string, end: string, nowMs: number): { from: string; to: string } | { error: "invalid" | "order" | "too_long" } {
  if (!DATE.test(start) || !DATE.test(end)) return { error: "invalid" }
  const startDay = Date.parse(`${start}T00:00:00Z`)
  const endDay = Date.parse(`${end}T00:00:00Z`)
  if (!Number.isFinite(startDay) || !Number.isFinite(endDay)) return { error: "invalid" }
  if (endDay < startDay) return { error: "order" }
  if ((endDay - startDay) / DAY_MS + 1 > MAX_CUSTOM_DAYS) return { error: "too_long" }
  const from = Math.floor(localMidnight(start) / HOUR_MS) * HOUR_MS
  const nowEnd = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS
  const afterEnd = Math.ceil(localMidnight(new Date(endDay + DAY_MS).toISOString().slice(0, 10)) / HOUR_MS) * HOUR_MS
  const to = Math.min(afterEnd, nowEnd)
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
const DESCRIBED_METRICS = new Set(["nic.total_bytes", "nic.tx_bytes", "nic.rx_bytes", "proxy.sent_bytes", "proxy.recv_bytes", "proxy.total_bytes", "proxy.connections", "probe.ok", "probe.fail", "probe.latency_ms"])
/** The i18n key explaining why a metric matters, or null when it has none. */
export const metricDescriptionKey = (metric: string): string | null => DESCRIBED_METRICS.has(metric) ? `dash.tlmAbout.${metric}` : null

/** Short plain-language names for the trojan agent's metrics whose raw names mislead (trojan counts from its side). */
const NAMED_METRICS = new Set(["nic.total_bytes", "nic.tx_bytes", "nic.rx_bytes", "proxy.sent_bytes", "proxy.recv_bytes", "proxy.total_bytes"])
export const metricNameKey = (metric: string): string | null => NAMED_METRICS.has(metric) ? `dash.tlmName.${metric}` : null
