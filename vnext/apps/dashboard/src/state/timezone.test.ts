import { describe, expect, test } from "bun:test"
import { localOffsetLabel, zoneOps } from "./timezone"

// localOffsetLabel is fed a Date only so the offset can be stubbed here; in the
// app it reads the real clock. Stubbing getTimezoneOffset rather than setting TZ
// keeps the case independent of which zones the test machine has installed.
function atOffset(minutesEastOfUtc: number): Date {
  const d = new Date("2026-08-12T12:00:00Z")
  // getTimezoneOffset is minutes *behind* UTC, i.e. the sign is inverted.
  d.getTimezoneOffset = () => -minutesEastOfUtc
  return d
}

describe("localOffsetLabel", () => {
  test("names whole-hour offsets without a minutes field", () => {
    expect(localOffsetLabel(atOffset(8 * 60))).toBe("UTC+8")
    expect(localOffsetLabel(atOffset(-5 * 60))).toBe("UTC-5")
  })

  test("UTC itself is a positive zero, not a bare 'UTC'", () => {
    expect(localOffsetLabel(atOffset(0))).toBe("UTC+0")
  })

  // India and Newfoundland are the reason the minutes are not assumed away.
  test("keeps the minutes of a half-hour offset", () => {
    expect(localOffsetLabel(atOffset(5 * 60 + 30))).toBe("UTC+5:30")
    expect(localOffsetLabel(atOffset(-(3 * 60 + 30)))).toBe("UTC-3:30")
  })

  // -12:45 would render as "UTC-12:-45" if the sign were not stripped before
  // splitting the minutes out.
  test("a negative offset with minutes keeps one sign", () => {
    expect(localOffsetLabel(atOffset(-(9 * 60 + 30)))).toBe("UTC-9:30")
  })
})

describe("zoneOps('utc')", () => {
  const utc = zoneOps("utc")

  test("make and the field readers round-trip", () => {
    const d = utc.make(2026, 7, 12, 15)
    expect(utc.year(d)).toBe(2026)
    expect(utc.month(d)).toBe(7)
    expect(utc.day(d)).toBe(12)
    expect(utc.hour(d)).toBe(15)
    expect(d.toISOString()).toBe("2026-08-12T15:00:00.000Z")
  })

  test("the hour defaults to midnight", () => {
    expect(utc.make(2026, 0, 1).toISOString()).toBe("2026-01-01T00:00:00.000Z")
  })

  // The bucket helpers step days and months by passing out-of-range values
  // straight into make(), so the normalisation has to be part of the contract.
  test("out-of-range fields normalise", () => {
    expect(utc.day(utc.make(2026, 6, 32))).toBe(1)
    expect(utc.month(utc.make(2026, 6, 32))).toBe(7)
    expect(utc.month(utc.make(2026, 12, 1))).toBe(0)
    expect(utc.year(utc.make(2026, 12, 1))).toBe(2027)
    expect(utc.day(utc.make(2026, 7, 0))).toBe(31)
  })

  test("weekday is 0 for Sunday", () => {
    // 2026-08-16 is a Sunday.
    expect(utc.weekday(utc.make(2026, 7, 16))).toBe(0)
    expect(utc.weekday(utc.make(2026, 7, 12))).toBe(3)
  })

  // Without this the labels would be formatted on the browser's clock while the
  // buckets were cut on UTC — the two would disagree by a day at the edges.
  test("fmt pins date formatting to UTC", () => {
    expect(utc.fmt.timeZone).toBe("UTC")
    const d = new Date("2026-08-12T23:30:00Z")
    expect(d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...utc.fmt })).toBe("Aug 12")
  })
})

describe("zoneOps('local')", () => {
  const local = zoneOps("local")

  test("reads the browser calendar and leaves formatting alone", () => {
    const d = new Date(2026, 7, 12, 15, 0, 0, 0)
    expect(local.year(d)).toBe(2026)
    expect(local.month(d)).toBe(7)
    expect(local.day(d)).toBe(12)
    expect(local.hour(d)).toBe(15)
    // No timeZone override: toLocaleDateString must stay on the default clock.
    expect(local.fmt.timeZone).toBeUndefined()
  })

  test("make round-trips through the field readers", () => {
    const d = local.make(2026, 7, 12, 15)
    expect(local.year(d)).toBe(2026)
    expect(local.month(d)).toBe(7)
    expect(local.day(d)).toBe(12)
    expect(local.hour(d)).toBe(15)
  })
})
