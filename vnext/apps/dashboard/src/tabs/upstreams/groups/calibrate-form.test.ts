import { expect, test } from "bun:test"
import { parseCalibration } from "./calibrate-form"

const NOW = 1_800_000_000_000
const form = (over: Partial<Parameters<typeof parseCalibration>[0]> = {}) => ({ used: "", entitlement: "", share: "", minutesAgo: "", ...over })

test("used and entitlement, or a used share, with the time as minutes ago", () => {
  expect(parseCalibration(form({ used: "450", entitlement: "1000" }), NOW)).toEqual({ ok: true, body: { used: 450, entitlement: 1000 } })
  expect(parseCalibration(form({ share: "37.5" }), NOW)).toEqual({ ok: true, body: { usedShare: 0.375 } })
  expect(parseCalibration(form({ share: "40", minutesAgo: "90" }), NOW)).toEqual({ ok: true, body: { usedShare: 0.4, at: NOW - 90 * 60_000 } })
})

test("incomplete or invalid input is refused with the reason", () => {
  expect(parseCalibration(form(), NOW)).toEqual({ ok: false, reason: "invalid" })
  expect(parseCalibration(form({ used: "-1", entitlement: "10" }), NOW)).toEqual({ ok: false, reason: "invalid" })
  expect(parseCalibration(form({ share: "x" }), NOW)).toEqual({ ok: false, reason: "invalid" })
  expect(parseCalibration(form({ share: "10", minutesAgo: "2000" }), NOW)).toEqual({ ok: false, reason: "invalid" })
  expect(parseCalibration(form({ share: "10", minutesAgo: "-5" }), NOW)).toEqual({ ok: false, reason: "invalid" })
  expect(parseCalibration(form({ entitlement: "1000" }), NOW)).toEqual({ ok: false, reason: "invalid" }) // an entitlement alone says nothing
  expect(parseCalibration(form({ share: "10", minutesAgo: "1440" }), NOW)).toEqual({ ok: false, reason: "invalid" }) // at most 1439 minutes
})

test("the server's bounds are checked first: at most 1.5 times the entitlement, and a time in the current month (UTC) after its first 30 minutes", () => {
  expect(parseCalibration(form({ used: "1500", entitlement: "1000" }), NOW)).toEqual({ ok: true, body: { used: 1500, entitlement: 1000 } })
  expect(parseCalibration(form({ used: "1501", entitlement: "1000" }), NOW)).toEqual({ ok: false, reason: "range" })
  expect(parseCalibration(form({ share: "150" }), NOW)).toEqual({ ok: true, body: { usedShare: 1.5 } })
  expect(parseCalibration(form({ share: "151" }), NOW)).toEqual({ ok: false, reason: "range" })
  const early = Date.UTC(2027, 0, 1, 1, 0) // 01:00 UTC on the 1st
  expect(parseCalibration(form({ share: "10", minutesAgo: "20" }), early)).toEqual({ ok: true, body: { usedShare: 0.1, at: early - 20 * 60_000 } })
  expect(parseCalibration(form({ share: "10", minutesAgo: "40" }), early)).toEqual({ ok: false, reason: "month" }) // 00:20 is inside the first 30 minutes
  expect(parseCalibration(form({ share: "10", minutesAgo: "120" }), early)).toEqual({ ok: false, reason: "month" }) // last month
})

test("used alone is accepted (the server uses the stored entitlement); a time not after the last read is refused", () => {
  expect(parseCalibration(form({ used: "450" }), NOW)).toEqual({ ok: true, body: { used: 450 } })
  expect(parseCalibration(form({ used: "450", entitlement: "1000", minutesAgo: "1439" }), NOW)).toEqual({ ok: true, body: { used: 450, entitlement: 1000, at: NOW - 1439 * 60_000 } })
  const lastRead = NOW - 30 * 60_000
  expect(parseCalibration(form({ share: "10", minutesAgo: "45" }), NOW, lastRead)).toEqual({ ok: false, reason: "afterRead" })
  expect(parseCalibration(form({ share: "10", minutesAgo: "30" }), NOW, lastRead)).toEqual({ ok: false, reason: "afterRead" })
  expect(parseCalibration(form({ share: "10", minutesAgo: "10" }), NOW, lastRead)).toEqual({ ok: true, body: { usedShare: 0.1, at: NOW - 10 * 60_000 } })
  expect(parseCalibration(form({ share: "10" }), NOW, lastRead)).toEqual({ ok: true, body: { usedShare: 0.1 } })
})
