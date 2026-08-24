import { describe, expect, test } from "bun:test"
import { computeTimeRange, formatDayLabel, formatMonthLabel, formatWeekLabel } from "./usage"
import { buildTimeBuckets, localDateKey, localDayStart } from "../components/TimeSeriesChart"

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

  // 28d is a trailing window ending now; it has no notion of a period to step
  // through, so the offset must not silently move it.
  test("28d ignores the offset", () => {
    expect(computeTimeRange("28d", -3, NOW)).toEqual(computeTimeRange("28d", 0, NOW))
  })
})

// 28 days rather than 30: four whole weeks, so every window holds the same
// number of Mondays and week-over-week comparisons are not skewed by which
// weekdays happened to fall inside it.
describe("computeTimeRange 28d", () => {
  test("trails 28 days back from today's midnight and ends at the current hour", () => {
    const r = computeTimeRange("28d", 0, NOW)
    expect(r.start).toBe(new Date(2026, 6, 16).toISOString().slice(0, 13))
    expect(r.end).toBe(new Date(NOW.getTime() + HOUR).toISOString().slice(0, 13))
  })

  // The picked day is the last day *in* the window, so the query has to run to
  // the midnight after it — an end of that same midnight would drop it.
  test("an explicit end date pins a 28-day window closing on that day", () => {
    const r = computeTimeRange("28d", 0, NOW, "2026-07-28")
    expect(r.start).toBe(new Date(2026, 6, 1).toISOString().slice(0, 13))
    expect(r.end).toBe(new Date(2026, 6, 29).toISOString().slice(0, 13))
  })

  test("today is a legal end date and closes the window tonight", () => {
    const r = computeTimeRange("28d", 0, NOW, "2026-08-12")
    expect(r.start).toBe(new Date(2026, 6, 16).toISOString().slice(0, 13))
    expect(r.end).toBe(new Date(2026, 7, 13).toISOString().slice(0, 13))
  })

  // Only 28d owns an end date; letting it leak would silently move the
  // calendar ranges away from the period the arrows say they are on.
  test("other ranges ignore an end date", () => {
    expect(computeTimeRange("week", 0, NOW, "2026-07-28")).toEqual(computeTimeRange("week", 0, NOW))
    expect(computeTimeRange("today", 0, NOW, "2026-07-28")).toEqual(computeTimeRange("today", 0, NOW))
  })

  // A malformed value comes back from history state or a hand-edited input;
  // falling back to the trailing window beats querying Invalid Date.
  test("falls back to the trailing window for an unusable end date", () => {
    for (const bad of ["", "nonsense", "2026-13-99"]) {
      expect(computeTimeRange("28d", 0, NOW, bad)).toEqual(computeTimeRange("28d", 0, NOW))
    }
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

  test("28d is 28 daily buckets ending today", () => {
    const b = buildTimeBuckets("28d", 0, NOW)
    expect(b.keys).toHaveLength(28)
    expect(b.isDaily).toBe(true)
    expect(b.keys[0]).toBe("2026-07-16")
    expect(b.keys[27]).toBe("2026-08-12")
  })

  // The summary reads computeTimeRange and the chart reads buildTimeBuckets;
  // if the start date only reached one of them the graph would plot a window
  // the numbers never covered.
  test("28d buckets close on an explicit end date", () => {
    const b = buildTimeBuckets("28d", 0, NOW, "2026-07-28")
    expect(b.keys).toHaveLength(28)
    expect(b.keys[0]).toBe("2026-07-01")
    expect(b.keys[27]).toBe("2026-07-28")
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

// Clicking a day in the week/month chart jumps to that day's own view, which
// means turning its bucket key back into a periodOffset.
describe("dayOffsetFromKey", () => {
  test("today is 0 and earlier days are negative", async () => {
    const { dayOffsetFromKey } = await import("./usage")
    expect(dayOffsetFromKey("2026-08-12", NOW)).toBe(0)
    expect(dayOffsetFromKey("2026-08-11", NOW)).toBe(-1)
    expect(dayOffsetFromKey("2026-08-05", NOW)).toBe(-7)
  })

  test("crosses a month boundary", async () => {
    const { dayOffsetFromKey } = await import("./usage")
    expect(dayOffsetFromKey("2026-07-31", NOW)).toBe(-12)
  })

  // A DST shift makes a day 23 or 25 hours long; dividing elapsed milliseconds
  // by 86400000 would land half a day off and select the wrong date.
  test("is unaffected by a day that is not 24 hours long", async () => {
    const { dayOffsetFromKey } = await import("./usage")
    // Whatever the local zone does, stepping back one calendar day from the
    // key must round-trip through computeTimeRange to that same key.
    for (const key of ["2026-03-08", "2026-11-01", "2026-08-11"]) {
      const offset = dayOffsetFromKey(key, NOW)
      const back = localDayStart(NOW, offset)
      expect(localDateKey(back)).toBe(key)
    }
  })

  test("a future day yields a positive offset the caller can reject", async () => {
    const { dayOffsetFromKey } = await import("./usage")
    expect(dayOffsetFromKey("2026-08-13", NOW)).toBe(1)
  })
})

// "View this day" pushes a history entry so the back button undoes it. The
// state comes back from the browser untrusted — it survives reloads, and other
// code on the page pushes its own entries.
describe("usageViewFromHistoryState", () => {
  test("reads a view this hook pushed", async () => {
    const { usageViewFromHistoryState } = await import("./usage")
    expect(usageViewFromHistoryState({ usageView: { range: "week", periodOffset: -2 } }))
      .toEqual({ range: "week", periodOffset: -2, endDate: null })
  })

  test("ignores history entries that are not ours", async () => {
    const { usageViewFromHistoryState } = await import("./usage")
    for (const s of [null, undefined, {}, "week", 7, { other: 1 }, { usageView: null }, { usageView: "week" }]) {
      expect(usageViewFromHistoryState(s)).toBeNull()
    }
  })

  test("rejects a range it does not know", async () => {
    const { usageViewFromHistoryState } = await import("./usage")
    expect(usageViewFromHistoryState({ usageView: { range: "fortnight", periodOffset: 0 } })).toBeNull()
    // 30d and 7d were Usage ranges once and are no longer reachable; entries
    // left over from before must not resurrect a range the tabs cannot show.
    expect(usageViewFromHistoryState({ usageView: { range: "30d", periodOffset: 0 } })).toBeNull()
    expect(usageViewFromHistoryState({ usageView: { range: "7d", periodOffset: 0 } })).toBeNull()
  })

  test("carries the 28d end date back with the entry", async () => {
    const { usageViewFromHistoryState } = await import("./usage")
    expect(usageViewFromHistoryState({ usageView: { range: "28d", periodOffset: 0, endDate: "2026-07-01" } }))
      .toEqual({ range: "28d", periodOffset: 0, endDate: "2026-07-01" })
  })

  test("drops an end date that is not a plain calendar day", async () => {
    const { usageViewFromHistoryState } = await import("./usage")
    for (const bad of ["2026-7-1", "yesterday", 20260701, "2026-07-01T00:00:00Z"]) {
      expect(usageViewFromHistoryState({ usageView: { range: "28d", periodOffset: 0, endDate: bad } }))
        .toEqual({ range: "28d", periodOffset: 0, endDate: null })
    }
  })

  // A positive offset would ask for a period in the future; a fractional one
  // would land between days.
  test("rejects an offset that could not have come from the UI", async () => {
    const { usageViewFromHistoryState } = await import("./usage")
    expect(usageViewFromHistoryState({ usageView: { range: "today", periodOffset: 3 } })).toBeNull()
    expect(usageViewFromHistoryState({ usageView: { range: "today", periodOffset: -1.5 } })).toBeNull()
    expect(usageViewFromHistoryState({ usageView: { range: "today", periodOffset: "-1" } })).toBeNull()
  })

  test("accepts the present period", async () => {
    const { usageViewFromHistoryState } = await import("./usage")
    expect(usageViewFromHistoryState({ usageView: { range: "month", periodOffset: 0 } }))
      .toEqual({ range: "month", periodOffset: 0, endDate: null })
  })
})
