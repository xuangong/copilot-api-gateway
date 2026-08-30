import { expect, test } from "bun:test"
import { AUTO_REFRESH_MINUTES, formatAge, isDue, MANUAL_ONLY, parseIntervalMs } from "./auto-refresh"

test("a stored cadence is read back in milliseconds", () => {
  expect(parseIntervalMs("5")).toBe(5 * 60_000)
  expect(parseIntervalMs("30")).toBe(30 * 60_000)
})

test("zero means the timer is off", () => {
  expect(parseIntervalMs("0")).toBe(MANUAL_ONLY)
})

test("an unoffered cadence falls back to manual rather than to a default poll", () => {
  // A hand-edited or stale key must never start a poll nobody asked for.
  expect(parseIntervalMs("7")).toBe(MANUAL_ONLY)
  expect(parseIntervalMs("0.1")).toBe(MANUAL_ONLY)
  expect(parseIntervalMs("-5")).toBe(MANUAL_ONLY)
})

test("a missing or unreadable key means manual", () => {
  expect(parseIntervalMs(null)).toBe(MANUAL_ONLY)
  expect(parseIntervalMs("")).toBe(MANUAL_ONLY)
  expect(parseIntervalMs("every 5 minutes")).toBe(MANUAL_ONLY)
})

test("manual is one of the offered choices, so the picker can express it", () => {
  expect(AUTO_REFRESH_MINUTES).toContain(MANUAL_ONLY)
})

test("nothing is owed while the timer is off, however old the data is", () => {
  expect(isDue(0, 86_400_000, MANUAL_ONLY)).toBe(false)
})

test("nothing is owed before the first fetch has landed", () => {
  // Otherwise mount would fire a poll on top of the fetch already in flight.
  expect(isDue(null, Date.now(), 60_000)).toBe(false)
})

test("a poll is owed once the cadence has elapsed", () => {
  const t0 = 1_700_000_000_000
  expect(isDue(t0, t0 + 59_000, 60_000)).toBe(false)
  expect(isDue(t0, t0 + 60_000, 60_000)).toBe(true)
  expect(isDue(t0, t0 + 600_000, 60_000)).toBe(true)
})

test("fresh data reads as just-updated rather than as zero minutes", () => {
  expect(formatAge(0).key).toBe("dash.usage.agoNow")
  expect(formatAge(59_000).key).toBe("dash.usage.agoNow")
})

test("age is reported in whole minutes, rounded down", () => {
  expect(formatAge(60_000)).toEqual({ key: "dash.usage.agoMinutes", n: 1 })
  expect(formatAge(119_000)).toEqual({ key: "dash.usage.agoMinutes", n: 1 })
  expect(formatAge(59 * 60_000)).toEqual({ key: "dash.usage.agoMinutes", n: 59 })
})

test("an hour or more is reported in hours, so the label stays short", () => {
  expect(formatAge(60 * 60_000)).toEqual({ key: "dash.usage.agoHours", n: 1 })
  expect(formatAge(150 * 60_000)).toEqual({ key: "dash.usage.agoHours", n: 2 })
})
