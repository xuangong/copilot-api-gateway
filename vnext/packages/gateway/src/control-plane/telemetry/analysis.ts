import type { TelemetryContribution, TelemetryDimRow, TelemetryGroupHours, TelemetryGroupTotal, TelemetryHourValue } from "../../repo/telemetry"
import type { TelemetrySettings } from "./protocol"

export const HOUR = 3600
export const DAY = 86_400
export const SURGE_WINDOW_HOURS = 168
export const SURGE_BASELINE_HOURS = 168
export const SURGE_HISTORY_HOURS = 24
export const MAX_SURGES = 20
export const MAX_SURGE_METRICS = 10
export const MAX_FLAG_HOURS = 50
export const DEFAULT_SURGE_FACTOR = 3
export const DEFAULT_SURGE_MIN_BYTES = 2 * 1024 ** 3
export const DEFAULT_SURGE_MIN_COUNT = 1000
export const DEFAULT_STALE_AFTER_HOURS = 2

export const floorHour = (seconds: number) => Math.floor(seconds / HOUR) * HOUR
export const floorDay = (seconds: number) => Math.floor(seconds / DAY) * DAY

export function monthStart(seconds: number): number {
  const date = new Date(seconds * 1000)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000
}

export function nextMonthStart(seconds: number): number {
  const date = new Date(seconds * 1000)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000
}

/** Absorbs floating point residue when a total is compared with the sum of its parts. */
const remainder = (total: number, parts: number) => {
  const value = total - parts
  return Math.abs(value) < 1e-6 ? 0 : Math.max(0, value)
}

// ---- month to date and projection ---------------------------------------------------------------------------------

export interface Projection { monthStart: number; mtd: number; averageDaily: number | null; projection: number }

/**
 * `rows` are hourly totals of the budget metric; they must cover the month so far and the last 7 complete days.
 * MTD runs from the UTC month start through the current hour. Only complete UTC days that start at or after the first data hour are averaged
 * (a partially covered first day would drag the average down).
 */
export function projectMonth(rows: readonly TelemetryHourValue[], firstHour: number | null, nowSec: number): Projection {
  const start = monthStart(nowSec)
  const end = floorHour(nowSec) + HOUR
  let mtd = 0
  for (const row of rows) if (row.hour >= start && row.hour < end) mtd += row.value
  const today = floorDay(nowSec)
  let sum = 0
  let days = 0
  if (firstHour !== null) {
    for (let back = 1; back <= 7; back++) {
      const dayStart = today - back * DAY
      if (dayStart < firstHour) continue
      days++
      for (const row of rows) if (row.hour >= dayStart && row.hour < dayStart + DAY) sum += row.value
    }
  }
  const averageDaily = days > 0 ? sum / days : null
  const remainingDays = (nextMonthStart(nowSec) - nowSec) / DAY
  return { monthStart: start, mtd, averageDaily, projection: mtd + (averageDaily ?? 0) * remainingDays }
}

/** Decimal gigabytes; null for non-byte metrics or when no price is set. */
export function costOf(value: number, unit: string, settings: Pick<TelemetrySettings, "pricePerGB" | "freeGB">): number | null {
  if (unit !== "bytes" || settings.pricePerGB === undefined) return null
  return Math.max(0, value / 1e9 - (settings.freeGB ?? 0)) * settings.pricePerGB
}

// ---- surges -------------------------------------------------------------------------------------------------------

export interface Surge { metric: string; hour: number; value: number; baseline: number; ratio: number | null }

export interface SurgeInput {
  metric: string
  unit: string
  /** Hourly totals covering at least 168 hours before the first judged hour. */
  hourly: readonly TelemetryHourValue[]
  /** The metric's earliest hour on record. */
  firstHour: number | null
  nowHour: number
  settings: TelemetrySettings
}

/** Surges within the last 168 hours up to `nowHour`, newest first. */
export function findSurges(input: SurgeInput): Surge[] {
  if (input.unit === "ms" || input.firstHour === null) return []
  const byHour = new Map(input.hourly.map(row => [row.hour, row.value]))
  const factor = input.settings.surgeFactor ?? DEFAULT_SURGE_FACTOR
  const minimum = input.unit === "bytes" ? input.settings.surgeMinBytes ?? DEFAULT_SURGE_MIN_BYTES : input.settings.surgeMinCount ?? DEFAULT_SURGE_MIN_COUNT
  const found: Surge[] = []
  for (let hour = input.nowHour; hour > input.nowHour - SURGE_WINDOW_HOURS * HOUR; hour -= HOUR) {
    const value = byHour.get(hour) ?? 0
    if (value <= 0 || hour - input.firstHour < SURGE_HISTORY_HOURS * HOUR) continue
    let sum = 0
    for (let back = 1; back <= SURGE_BASELINE_HOURS; back++) sum += byHour.get(hour - back * HOUR) ?? 0
    const baseline = sum / SURGE_BASELINE_HOURS
    if (value >= factor * baseline && value >= minimum) found.push({ metric: input.metric, hour, value, baseline, ratio: baseline > 0 ? value / baseline : null })
  }
  return found
}

export function selectSurges(all: readonly Surge[]): Surge[] {
  return [...all].sort((a, b) => b.hour - a.hour || a.metric.localeCompare(b.metric)).slice(0, MAX_SURGES)
}

export interface SurgeWithContributors extends Surge { contributors: TelemetryContribution[] }

// ---- non-zero flags and point-in-time checks ----------------------------------------------------------------------

export interface FlagEntry { dims: Record<string, string>; value: number }
export interface NonZeroFlag { metric: string; hour: number; total: number; breakdown: FlagEntry[] }

/** Groups non-zero rows by metric and hour, newest first, for at most `maxHours` distinct hours. */
export function nonZeroFlags(rows: readonly TelemetryDimRow[], maxHours = MAX_FLAG_HOURS): NonZeroFlag[] {
  const groups = new Map<string, NonZeroFlag>()
  for (const row of rows) {
    if (row.value <= 0) continue
    const key = `${row.metric}\u0000${row.hour}`
    const flag = groups.get(key) ?? { metric: row.metric, hour: row.hour, total: 0, breakdown: [] }
    flag.total += row.value
    if (Object.keys(row.dims).length > 0) flag.breakdown.push({ dims: row.dims, value: row.value })
    groups.set(key, flag)
  }
  const flags = [...groups.values()].sort((a, b) => b.hour - a.hour || a.metric.localeCompare(b.metric))
  for (const flag of flags) flag.breakdown.sort((a, b) => b.value - a.value || JSON.stringify(a.dims).localeCompare(JSON.stringify(b.dims)))
  const keep = new Set<number>()
  for (const flag of flags) if (keep.size < maxHours) keep.add(flag.hour)
  return flags.filter(flag => keep.has(flag.hour))
}

/** `rows` are newest hour first. When the query hit its row `limit`, the oldest hour may be cut off mid-way, so all its rows are dropped. */
export function dropPartialHour<T extends { hour: number }>(rows: T[], limit: number): T[] {
  if (rows.length < limit || rows.length === 0) return rows
  const oldest = rows[rows.length - 1]!.hour
  return rows.filter(row => row.hour !== oldest)
}

export type CheckStatus = "passed" | "failed" | "no check" | "not monitored"

/** The metric that records why `<name>.ok` failed: `<name>.fail`. Null for other names. */
export function failMetricOf(checkMetric: string): string | null {
  return checkMetric.endsWith(".ok") ? `${checkMetric.slice(0, -".ok".length)}.fail` : null
}

/**
 * Per hour: `passed` (value > 0), `failed` (value = 0), `no check` (no point at or after the metric's first point) or
 * `not monitored` (before the first point, or the metric has no points at all).
 */
export function checkStatuses(hours: readonly number[], values: readonly TelemetryHourValue[], firstHour: number | null): CheckStatus[] {
  const byHour = new Map(values.map(row => [row.hour, row.value]))
  return hours.map((hour): CheckStatus => {
    if (firstHour === null || hour < firstHour) return "not monitored"
    const value = byHour.get(hour)
    if (value === undefined) return "no check"
    return value > 0 ? "passed" : "failed"
  })
}

/** The failing stage recorded for a check hour, read from the matching `.fail` flag. */
export function stageOf(flags: readonly NonZeroFlag[], checkMetric: string, hour: number): string | null {
  const failMetric = failMetricOf(checkMetric)
  if (failMetric === null) return null
  const flag = flags.find(entry => entry.metric === failMetric && entry.hour === hour)
  return flag?.breakdown.find(entry => entry.dims.stage !== undefined)?.dims.stage ?? null
}

export interface LatestCheck { metric: string; hour: number; status: CheckStatus; stage: string | null }

/** The check result for the latest closed hour. */
export function latestCheck(metric: string, nowSec: number, values: readonly TelemetryHourValue[], firstHour: number | null, flags: readonly NonZeroFlag[]): LatestCheck {
  const hour = floorHour(nowSec) - HOUR
  const status = checkStatuses([hour], values, firstHour)[0]!
  return { metric, hour, status, stage: status === "failed" ? stageOf(flags, metric, hour) : null }
}

// ---- freshness ----------------------------------------------------------------------------------------------------

export interface Freshness { lastPushAt: string | null; stale: boolean; staleAfterHours: number; hoursSincePush: number | null }

export function freshness(lastPushAt: string | null, nowMs: number, staleAfterHours = DEFAULT_STALE_AFTER_HOURS): Freshness {
  if (lastPushAt === null) return { lastPushAt: null, stale: false, staleAfterHours, hoursSincePush: null }
  const age = nowMs - Date.parse(lastPushAt)
  return { lastPushAt, stale: age > staleAfterHours * 3_600_000, staleAfterHours, hoursSincePush: Math.max(0, Math.floor(age / 3_600_000)) }
}

// ---- series and top -----------------------------------------------------------------------------------------------

export interface BuiltSeries { hours: number[]; total: number[]; groups: Array<{ key: string; values: number[] }> }

/** Dense hourly arrays over `[from, to)`. The remainder after the listed groups is one `(other)` group. */
export function buildSeries(window: { from: number; to: number }, totals: readonly TelemetryHourValue[], groups: readonly TelemetryGroupHours[]): BuiltSeries {
  const hours: number[] = []
  for (let hour = window.from; hour < window.to; hour += HOUR) hours.push(hour)
  const totalByHour = new Map(totals.map(row => [row.hour, row.value]))
  const total = hours.map(hour => totalByHour.get(hour) ?? 0)
  const built = groups.map(group => {
    const byHour = new Map(group.points.map(point => [point.hour, point.value]))
    return { key: group.key, values: hours.map(hour => byHour.get(hour) ?? 0) }
  })
  if (built.length === 0) return { hours, total, groups: [] }
  const other = total.map((value, index) => remainder(value, built.reduce((sum, group) => sum + group.values[index]!, 0)))
  if (other.some(value => value > 0)) built.push({ key: "(other)", values: other })
  return { hours, total, groups: built }
}

export interface TopRow { key: string; value: number; share: number; previous: number; change: number | null }
export interface TopResult { total: number; rows: TopRow[]; otherCurrent: number; otherShare: number }

export function buildTop(total: number, groups: readonly TelemetryGroupTotal[], previous: readonly TelemetryGroupTotal[]): TopResult {
  const before = new Map(previous.map(group => [group.key, group.value]))
  const rows = groups.map((group): TopRow => {
    const prior = before.get(group.key) ?? 0
    return { key: group.key, value: group.value, share: total > 0 ? group.value / total : 0, previous: prior, change: prior > 0 ? (group.value - prior) / prior : null }
  })
  const otherCurrent = remainder(total, groups.reduce((sum, group) => sum + group.value, 0))
  return { total, rows, otherCurrent, otherShare: total > 0 ? otherCurrent / total : 0 }
}
