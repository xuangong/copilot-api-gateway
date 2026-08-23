import { describe, expect, test } from "bun:test"
import { computeTimeRange, formatDayLabel, formatMonthLabel, formatWeekLabel } from "./usage"
import { buildTimeBuckets } from "../components/TimeSeriesChart"

// A Wednesday, mid-month, mid-afternoon local time — far enough from any
// boundary that a day/week/month step cannot accidentally land on the same
// value for the wrong reason.
const NOW = new Date(2026, 7, 12, 15, 30, 0, 0)

const HOUR = 3600_000
const DAY = 24 * HOUR

describe("computeTimeRange today", () => {
  test("covers exactly the calendar day, not a trailing window", () => {
    const r = computeTimeRange("today", 0, NOW)
    expect(r.start).toBe(new Date(2026, 7, 12).toISOString().slice(0, 13))
    expect(r.end).toBe(new Date(2026, 7, 13).toISOString().slice(0, 13))
  })

  test("a negative offset steps back whole days", () => {
    const r = computeTimeRange("today", -1, NOW)
    expect(r.start).toBe(new Date(2026, 7, 11).toISOString().slice(0, 13))
    expect(r.end).toBe(new Date(2026, 7, 12).toISOString().slice(0, 13))
  })

  test("steps across a month boundary", () => {
    const r = computeTimeRange("today", -12, NOW)
    expect(r.start).toBe(new Date(2026, 6, 31).toISOString().slice(0, 13))
  })
})

describe("computeTimeRange other ranges are unchanged", () => {
  test("week is still the Monday-anchored calendar week", () => {
    const r = computeTimeRange("week", 0, NOW)
    expect(r.start).toBe(new Date(2026, 7, 10).toISOString().slice(0, 13))
    expect(r.end).toBe(new Date(2026, 7, 17).toISOString().slice(0, 13))
  })

  test("month is still the calendar month", () => {
    const r = computeTimeRange("month", -1, NOW)
    expect(r.start).toBe(new Date(2026, 6, 1).toISOString().slice(0, 13))
    expect(r.end).toBe(new Date(2026, 7, 1).toISOString().slice(0, 13))
  })

  // 7d/30d are trailing windows ending now; they have no notion of a period to
  // step through, so the offset must not silently move them.
  test("7d and 30d ignore the offset", () => {
    expect(computeTimeRange("7d", -3, NOW)).toEqual(computeTimeRange("7d", 0, NOW))
    expect(computeTimeRange("30d", -3, NOW)).toEqual(computeTimeRange("30d", 0, NOW))
  })

  test("7d still ends at the current hour rather than midnight", () => {
    expect(computeTimeRange("7d", 0, NOW).end).toBe(new Date(NOW.getTime() + HOUR).toISOString().slice(0, 13))
  })
})

describe("formatDayLabel", () => {
  test("names today and yesterday, dates the rest", () => {
    expect(formatDayLabel(0, NOW)).toBe("Today (Aug 12)")
    expect(formatDayLabel(-1, NOW)).toBe("Yesterday (Aug 11)")
    expect(formatDayLabel(-2, NOW)).toBe("Aug 10, 2026")
  })
})

describe("existing labels still work", () => {
  test("week and month keep their wording", () => {
    expect(formatWeekLabel(0, NOW)).toStartWith("This week (")
    expect(formatWeekLabel(-1, NOW)).toStartWith("Last week (")
    expect(formatMonthLabel(0, NOW)).toBe("This month (August 2026)")
    expect(formatMonthLabel(-1, NOW)).toBe("Last month (July 2026)")
  })
})

describe("buildTimeBuckets today", () => {
  test("24 hourly buckets of the selected day", () => {
    const b = buildTimeBuckets("today", 0, NOW)
    expect(b.keys).toHaveLength(24)
    expect(b.isDaily).toBe(false)
    expect(b.keys[0]).toBe("2026-08-12T00")
    expect(b.keys[23]).toBe("2026-08-12T23")
  })

  // Without this the chart would keep plotting today's hours while the summary
  // showed a previous day — the numbers and the graph would disagree.
  test("the offset moves the buckets onto that day", () => {
    const b = buildTimeBuckets("today", -1, NOW)
    expect(b.keys[0]).toBe("2026-08-11T00")
    expect(b.keys[23]).toBe("2026-08-11T23")
    expect(b.labels[0]).toBe("00:00 – 01:00")
  })

  test("week buckets still follow their offset", () => {
    expect(buildTimeBuckets("week", -1, NOW).keys[0]).toBe("2026-08-03")
  })
})

describe("bucket keys line up with the queried range", () => {
  // The summary reads computeTimeRange; the chart reads buildTimeBuckets. If
  // they disagree the chart silently drops rows.
  test("today's first bucket is the queried start hour", () => {
    for (const offset of [0, -1, -7]) {
      const start = computeTimeRange("today", offset, NOW).start
      const firstBucket = buildTimeBuckets("today", offset, NOW).keys[0]!
      const asUtc = new Date(`${firstBucket}:00:00`).toISOString().slice(0, 13)
      expect(asUtc).toBe(start)
    }
  })

  test("today's span is exactly one day", () => {
    const { start, end } = computeTimeRange("today", -1, NOW)
    const span = new Date(`${end}:00:00Z`).getTime() - new Date(`${start}:00:00Z`).getTime()
    expect(span).toBe(DAY)
  })
})
