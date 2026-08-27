import { describe, expect, test } from "bun:test"
import { dateKey, hourKey, parseDateKey, utcHourToBucketKey } from "./time-buckets"
import { zoneOps } from "./timezone"

const UTC = zoneOps("utc")

// Rows are stored on the UTC hour whatever mode the dashboard is in, so this is
// the one function where the choice of clock actually changes which bucket a
// number lands in. Asserted against a hand-built zone rather than the machine's,
// so the case says the same thing wherever it runs.
const BEIJING = {
  year: (d: Date) => shift(d).getUTCFullYear(),
  month: (d: Date) => shift(d).getUTCMonth(),
  day: (d: Date) => shift(d).getUTCDate(),
  hour: (d: Date) => shift(d).getUTCHours(),
  weekday: (d: Date) => shift(d).getUTCDay(),
  make: (y: number, m: number, d: number, h = 0) => new Date(Date.UTC(y, m, d, h) - 8 * 3600_000),
  fmt: { timeZone: "Asia/Shanghai" } as Intl.DateTimeFormatOptions,
}
function shift(d: Date): Date {
  return new Date(d.getTime() + 8 * 3600_000)
}

describe("utcHourToBucketKey", () => {
  // The whole point of the switch: the first eight hours of a Beijing day
  // belong to the *previous* UTC day, which is the day quotas reset on.
  test("the same stored hour lands on different days in the two zones", () => {
    expect(utcHourToBucketKey("2026-07-31T16", true, BEIJING)).toBe("2026-08-01")
    expect(utcHourToBucketKey("2026-07-31T16", true, UTC)).toBe("2026-07-31")
  })

  test("hourly buckets shift by the offset", () => {
    expect(utcHourToBucketKey("2026-08-12T02", false, BEIJING)).toBe("2026-08-12T10")
    expect(utcHourToBucketKey("2026-08-12T02", false, UTC)).toBe("2026-08-12T02")
  })

  test("a mid-day hour agrees in both zones", () => {
    expect(utcHourToBucketKey("2026-08-12T02", true, BEIJING)).toBe("2026-08-12")
    expect(utcHourToBucketKey("2026-08-12T02", true, UTC)).toBe("2026-08-12")
  })
})

describe("key formatting", () => {
  test("pads months, days and hours to two digits", () => {
    const d = UTC.make(2026, 0, 5, 7)
    expect(dateKey(d, UTC)).toBe("2026-01-05")
    expect(hourKey(d, UTC)).toBe("2026-01-05T07")
  })
})

describe("parseDateKey", () => {
  test("reads a plain calendar day on the given clock", () => {
    const d = parseDateKey("2026-08-12", UTC)!
    expect(d.toISOString()).toBe("2026-08-12T00:00:00.000Z")
  })

  // new Date("2026-08-12") would always read as UTC midnight, which is the
  // previous day west of Greenwich — hence the field-by-field parse.
  test("midnight is midnight in the zone asked for, not in UTC", () => {
    const d = parseDateKey("2026-08-12", BEIJING)!
    expect(d.toISOString()).toBe("2026-08-11T16:00:00.000Z")
    expect(dateKey(d, BEIJING)).toBe("2026-08-12")
  })

  test("rejects anything that is not a real day", () => {
    for (const bad of ["", "2026-8-1", "2026-13-01", "2026-02-30", "yesterday", "2026-08-12T00", null, undefined]) {
      expect(parseDateKey(bad, UTC)).toBeNull()
    }
  })

  test("round-trips through dateKey", () => {
    for (const key of ["2026-01-01", "2026-02-28", "2026-12-31"]) {
      expect(dateKey(parseDateKey(key, UTC)!, UTC)).toBe(key)
    }
  })
})
