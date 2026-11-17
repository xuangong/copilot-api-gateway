// apps/dashboard/src/tabs/telemetry/telemetry-format-clock.test.ts
import { afterEach, expect, test } from "bun:test"
import { formatClockMs, formatInstantMs, formatUntil, setDisplayZone } from "./telemetry-format"

afterEach(() => setDisplayZone(null))

test("clock, instant and until text follow the display zone, not UTC", () => {
  setDisplayZone("Asia/Shanghai")
  const at = Date.UTC(2026, 10, 17, 10, 40) // 18:40 in Shanghai
  expect(formatClockMs(at)).toBe("18:40")
  expect(formatInstantMs(at)).toBe("2026-11-17 18:40")
  expect(formatUntil(at, Date.UTC(2026, 10, 17, 2, 0))).toBe("18:40") // 10:00 local the same day: just the clock
  expect(formatUntil(at, Date.UTC(2026, 10, 16, 2, 0))).toBe("11-17 18:40") // another local day: with the date
  setDisplayZone("UTC")
  expect(formatClockMs(at)).toBe("10:40")
})

test("a time just before local midnight is the same day for a nearby now, the next day for an earlier one", () => {
  setDisplayZone("America/New_York")
  const at = Date.UTC(2026, 10, 18, 4, 30) // 23:30 on Nov 17 in New York (UTC-5)
  expect(formatUntil(at, Date.UTC(2026, 10, 17, 15, 0))).toBe("23:30")
  expect(formatUntil(at, Date.UTC(2026, 10, 18, 6, 0))).toBe("11-17 23:30")
})
