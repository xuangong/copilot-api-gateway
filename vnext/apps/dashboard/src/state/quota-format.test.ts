// apps/dashboard/src/state/quota-format.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { MemberStatus } from "../api/upstream-groups"
import { installDictionary } from "./i18n-fixture"
import { amountText, barSegments, entitlementChangeText, memberTone, percentText, reasonKey, sourceLabel, usedOfText } from "./quota-format"

const NOW = Date.UTC(2026, 10, 22, 12, 0)
let restore: () => void = () => {}
beforeEach(() => { restore = installDictionary("en") })
afterEach(() => restore())
const member = (over: Partial<MemberStatus> = {}): MemberStatus => ({
  upstreamId: "up_a", name: "A", login: "a", enabled: true, unlimited: false, usedShare: 0.5, entitlement: 1000, estimatedUsed: 500, projectedShare: 0.7,
  lastRead: { at: NOW - 3 * 3_600_000, source: "github", used: 450, entitlement: 1000, share: 0.45 }, k: 0.02, kPrevious: null, kSamples: 5, kSource: { kind: "own" }, outsideRate: 0, outsideShareLastDay: null,
  lastErrorPoints: null, intervalHours: 6, nextReadAt: NOW, failures: 0, lastError: null, readFailing: false, entitlementChange: null, cutOff: null, eligibility: { eligible: true, reason: null }, activeSessions: 0, ...over,
})

test("shares are percentages, small ones with a decimal; amounts are grouped", () => {
  expect(percentText(0.5)).toBe("50%")
  expect(percentText(0.036)).toBe("3.6%")
  expect(percentText(1.1)).toBe("110%")
  expect(percentText(null)).toBe("—")
  expect(amountText(1234567)).toBe("1,234,567")
  expect(usedOfText(member())).toBe("500 / 1,000")
  expect(usedOfText(member({ usedShare: null, estimatedUsed: null }))).toBeNull()
})

test("the bar has a solid part (the last read) and a shaded part (the estimate on top), never beyond 100%", () => {
  expect(barSegments(member())).toEqual({ read: 45, estimated: 5, total: 50 })
  expect(barSegments(member({ usedShare: 1.2, lastRead: { at: NOW, source: "github", used: 1100, entitlement: 1000, share: 1.1 } }))).toEqual({ read: 100, estimated: 0, total: 100 })
  expect(barSegments(member({ usedShare: null, lastRead: null }))).toEqual({ read: 0, estimated: 0, total: 0 })
})

test("a known share without a read is drawn entirely as estimate and labelled as such; percent decimals follow the rounded value", () => {
  expect(barSegments(member({ usedShare: 0.3, lastRead: null }))).toEqual({ read: 0, estimated: 30, total: 30 })
  expect(sourceLabel(member({ usedShare: 0.3, lastRead: null }), NOW, window.t!)).toBe("estimate · no read yet")
  expect(percentText(0.0996)).toBe("10%")
  expect(percentText(0.0949)).toBe("9.5%")
  expect(percentText(0.0951)).toBe("10%")
})

test("the tone follows the group's lines", () => {
  expect(memberTone(0.5, 0.9, 0.95)).toBe("brand")
  expect(memberTone(0.9, 0.9, 0.95)).toBe("warn")
  expect(memberTone(0.95, 0.9, 0.95)).toBe("danger")
})

test("the source label says where the number comes from and how old it is", () => {
  const t = window.t!
  expect(sourceLabel(member({ lastRead: { at: NOW - 20_000, source: "github", used: 500, entitlement: 1000, share: 0.5 } }), NOW, t)).toBe("GitHub, live · just now")
  expect(sourceLabel(member(), NOW, t)).toBe("estimate · last read 3 hours ago")
  expect(sourceLabel(member({ usedShare: 0.45 }), NOW, t)).toBe("GitHub · read 3 hours ago")
  expect(sourceLabel(member({ lastRead: { at: NOW - 3_600_000, source: "manual", used: 450, entitlement: 1000, share: 0.45 } }), NOW, t)).toBe("calibrated by hand · 1 hour ago")
  expect(sourceLabel(member({ lastRead: null, usedShare: null }), NOW, t)).toBe("Not read yet: takes no new sessions until it is read or calibrated")
})

test("an entitlement change reads 'from X to Y' with the local time", () => {
  expect(entitlementChangeText({ from: 1000, to: 2000, at: NOW - 3_600_000 }, window.t!, NOW)).toBe("Entitlement changed from 1,000 to 2,000 (1 hour ago)")
})

test("unknown figures are dashes, never zero", () => {
  expect(percentText(null)).toBe("—")
  expect(usedOfText(member({ estimatedUsed: null }))).toBeNull()
  expect(barSegments(member({ usedShare: null }))).toEqual({ read: 0, estimated: 0, total: 0 })
})

test("every ineligibility reason has a text key", () => {
  for (const reason of ["group_disabled", "disabled", "cut_off", "paused", "no_read", "soft_line"] as const) expect(window.t!(reasonKey(reason))).not.toStartWith("dash.")
})
