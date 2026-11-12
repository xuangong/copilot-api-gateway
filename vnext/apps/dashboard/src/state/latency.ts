import { zoneOps, type TimeZoneMode } from "./timezone"

export type LatencyRange = "today" | "week" | "7d" | "30d"

// Compute [start, end) ISO-13-char window (YYYY-MM-DDTHH) to match
// the legacy `computeTimeRange` helper used by the Alpine dashboard.
// `mode` is the same dashboard-wide preference the Usage tab exposes, so both
// tabs agree on where a day begins.
export function computeTimeRange(range: LatencyRange, weekOffset: number, mode: TimeZoneMode): { start: string; end: string } {
  const ops = zoneOps(mode)
  const now = new Date()
  let start: Date, end: Date
  if (range === "week") {
    const ref = ops.make(ops.year(now), ops.month(now), ops.day(now) + weekOffset * 7)
    const monday = ops.make(ops.year(ref), ops.month(ref), ops.day(ref) - ((ops.weekday(ref) + 6) % 7))
    start = monday
    end = ops.make(ops.year(monday), ops.month(monday), ops.day(monday) + 7)
  } else {
    // Counted in calendar days rather than by subtracting milliseconds, so a
    // DST shift cannot leave the window an hour short of its first day.
    const back = range === "today" ? 0 : range === "7d" ? 6 : 29
    start = ops.make(ops.year(now), ops.month(now), ops.day(now) - back)
    end = new Date(now.getTime() + 3600000)
  }
  return {
    start: start.toISOString().slice(0, 13),
    end: end.toISOString().slice(0, 13),
  }
}

export function formatWeekLabel(weekOffset: number, mode: TimeZoneMode): string {
  const ops = zoneOps(mode)
  const now = new Date()
  const ref = ops.make(ops.year(now), ops.month(now), ops.day(now) + weekOffset * 7)
  const monday = ops.make(ops.year(ref), ops.month(ref), ops.day(ref) - ((ops.weekday(ref) + 6) % 7))
  const sunday = ops.make(ops.year(monday), ops.month(monday), ops.day(monday) + 6)
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...ops.fmt })
  if (weekOffset === 0) return `This week (${fmt(monday)} – ${fmt(sunday)})`
  if (weekOffset === -1) return `Last week (${fmt(monday)} – ${fmt(sunday)})`
  return `${fmt(monday)} – ${fmt(sunday)}`
}
