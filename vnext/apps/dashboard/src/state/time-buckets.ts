import { zoneOps, type TimeZoneMode, type ZoneOps } from "./timezone"

// — Bucket helpers, originally ported from src/ui/dashboard/client.ts —
//
// Every one of these takes an explicit ZoneOps rather than defaulting to the
// browser's zone. A default would let a call site quietly fall back to local
// time, which is exactly the implicit behaviour the UTC/local switch exists to
// remove: the bug would look like correct code.

export function hourKey(d: Date, ops: ZoneOps): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${ops.year(d)}-${p(ops.month(d) + 1)}-${p(ops.day(d))}T${p(ops.hour(d))}`
}

export function dateKey(d: Date, ops: ZoneOps): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${ops.year(d)}-${p(ops.month(d) + 1)}-${p(ops.day(d))}`
}

/** Midnight of the day containing `ref`, offset by whole days. */
export function dayStart(ref: Date, dayDelta: number, ops: ZoneOps): Date {
  return ops.make(ops.year(ref), ops.month(ref), ops.day(ref) + dayDelta)
}

/** Midnight on the 1st of the month containing `ref`, offset by whole months. */
export function monthStart(ref: Date, monthDelta: number, ops: ZoneOps): Date {
  return ops.make(ops.year(ref), ops.month(ref) + monthDelta, 1)
}

export type TimeBucketRange = "today" | "week" | "7d" | "28d" | "30d" | "month"

/** How many daily buckets each trailing window holds. */
export const TRAILING_WINDOW_DAYS: Record<"7d" | "28d" | "30d", number> = { "7d": 7, "28d": 28, "30d": 30 }

/**
 * Midnight of a "YYYY-MM-DD" day, or null when the string is not one. Parsed
 * field by field rather than through `new Date(s)`, which always reads a bare
 * date as UTC and so lands on the previous day west of Greenwich even when the
 * caller asked for local.
 */
export function parseDateKey(key: string | null | undefined, ops: ZoneOps): Date | null {
  if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const [y, m, d] = key.split("-").map(Number) as [number, number, number]
  const date = ops.make(y, m - 1, d)
  // Rejects the impossible days a regex still admits (2026-13-99 rolls over).
  if (ops.year(date) !== y || ops.month(date) !== m - 1 || ops.day(date) !== d) return null
  return date
}

export interface TimeBuckets {
  keys: string[]
  labels: string[]
  isDaily: boolean
}

/**
 * `periodOffset` shifts the window backwards for the two calendar ranges:
 * whole weeks for "week", whole months for "month". Ignored by the rest.
 *
 * `endDate` ("YYYY-MM-DD") pins the trailing windows to a chosen last day
 * instead of ending them at today; it is ignored by every other range, and an
 * unparseable value falls back to the trailing window.
 *
 * `mode` decides which zone the day boundaries fall on. The bucket *keys* are
 * wall-clock strings in that zone, so they only line up with rows fed through
 * utcHourToBucketKey under the same mode.
 */
export function buildTimeBuckets(
  range: TimeBucketRange,
  periodOffset: number,
  now: Date,
  endDate: string | null | undefined,
  mode: TimeZoneMode,
): TimeBuckets {
  const ops = zoneOps(mode)
  const keys: string[] = []
  const labels: string[] = []
  const isDaily = range !== "today"
  const dayLabel = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...ops.fmt })

  if (range === "today") {
    // Follows periodOffset for the same reason computeTimeRange does: the
    // chart and the summary must describe the same day.
    const day = dayStart(now, periodOffset, ops)
    for (let h = 0; h < 24; h++) {
      keys.push(hourKey(ops.make(ops.year(day), ops.month(day), ops.day(day), h), ops))
      const next = String((h + 1) % 24).padStart(2, "0")
      labels.push(`${String(h).padStart(2, "0")}:00 – ${next}:00`)
    }
  } else if (range === "week") {
    const ref = ops.make(ops.year(now), ops.month(now), ops.day(now) + periodOffset * 7)
    const monday = ops.make(ops.year(ref), ops.month(ref), ops.day(ref) - ((ops.weekday(ref) + 6) % 7))
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    for (let i = 0; i < 7; i++) {
      const d = ops.make(ops.year(monday), ops.month(monday), ops.day(monday) + i)
      keys.push(dateKey(d, ops))
      labels.push(`${weekdays[i]} ${dayLabel(d)}`)
    }
  } else if (range === "month") {
    const first = monthStart(now, periodOffset, ops)
    const nextFirst = monthStart(now, periodOffset + 1, ops)
    // Stepped by index off the 1st rather than by mutating a cursor: overflow
    // normalisation in make() ends the month for us, and a DST day cannot make
    // the cursor drift.
    for (let i = 0; ; i++) {
      const d = ops.make(ops.year(first), ops.month(first), 1 + i)
      if (d >= nextFirst) break
      keys.push(dateKey(d, ops))
      labels.push(dayLabel(d))
    }
  } else {
    const days = TRAILING_WINDOW_DAYS[range]
    // The picked day is the last day *in* the window, so the window opens
    // days-1 days before it; counted in calendar days so a DST shift cannot
    // slide the first bucket onto the wrong date.
    const pinned = parseDateKey(endDate, ops)
    const first = pinned
      ? ops.make(ops.year(pinned), ops.month(pinned), ops.day(pinned) - (days - 1))
      : dayStart(now, -(days - 1), ops)
    for (let i = 0; i < days; i++) {
      const d = ops.make(ops.year(first), ops.month(first), ops.day(first) + i)
      keys.push(dateKey(d, ops))
      labels.push(dayLabel(d))
    }
  }

  return { keys, labels, isDaily }
}

/**
 * Which bucket a stored row belongs to. Rows are keyed by UTC hour whatever the
 * selected mode is — the storage format never changes — so this is the single
 * point where the stored instant is re-read on the chosen clock.
 */
export function utcHourToBucketKey(utcHour: string, isDaily: boolean, ops: ZoneOps): string {
  const d = new Date(utcHour + ":00:00Z")
  return isDaily ? dateKey(d, ops) : hourKey(d, ops)
}
