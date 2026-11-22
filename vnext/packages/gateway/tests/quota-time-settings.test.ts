// packages/gateway/tests/quota-time-settings.test.ts
import { expect, test } from "bun:test"
import { hoursLeftInMonth, monthKey, monthStartMs, nextMonthStartMs } from "../src/quota-balance/time"
import { GroupSettingsError, normalizeGroupSettings } from "../src/quota-balance/settings"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"

test("UTC month boundaries", () => {
  const t = Date.UTC(2026, 10, 22, 13, 30)
  expect(monthStartMs(t)).toBe(Date.UTC(2026, 10, 1))
  expect(nextMonthStartMs(t)).toBe(Date.UTC(2026, 11, 1))
  expect(nextMonthStartMs(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1))
  expect(monthKey(t)).toBe("2026-11")
  expect(hoursLeftInMonth(Date.UTC(2026, 10, 30, 12))).toBe(12)
})

test("settings: absent keys keep the current value, unknown keys and out-of-range values throw without echoing the value", () => {
  expect(normalizeGroupSettings({ softShare: 0.8, confirmShare: 0.8 })).toEqual({ ...DEFAULT_GROUP_SETTINGS, softShare: 0.8, confirmShare: 0.8 })
  expect(normalizeGroupSettings({ exhaustedPolicy: "overage" }, { ...DEFAULT_GROUP_SETTINGS, softShare: 0.7, confirmShare: 0.7 })).toEqual({ ...DEFAULT_GROUP_SETTINGS, softShare: 0.7, confirmShare: 0.7, exhaustedPolicy: "overage" })
  expect(() => normalizeGroupSettings({ nope: 1 })).toThrow(GroupSettingsError)
  expect(() => normalizeGroupSettings({ toleranceShare: 0.9 })).toThrow("settings.toleranceShare must be a number between 0 and 0.5")
  expect(() => normalizeGroupSettings({ idleRebalanceMinutes: 2.5 })).toThrow("settings.idleRebalanceMinutes must be an integer between 1 and 1440")
  expect(() => normalizeGroupSettings({ exhaustedPolicy: "ignore" })).toThrow("settings.exhaustedPolicy must be stop or overage")
  expect(() => normalizeGroupSettings({ softShare: 0.96 })).toThrow("settings.softShare must be below hardShare")
  expect(() => normalizeGroupSettings([])).toThrow("settings must be an object")
  try { normalizeGroupSettings({ softShare: 123456 }) } catch (error) { expect(String(error)).not.toContain("123456") }
})

test("settings: confirmShare <= softShare < hardShare", () => {
  expect(() => normalizeGroupSettings({ softShare: 0.9, hardShare: 0.9 })).toThrow("settings.softShare must be below hardShare")
  expect(() => normalizeGroupSettings({ confirmShare: 0.93 })).toThrow("settings.confirmShare must not exceed softShare")
  expect(normalizeGroupSettings({ confirmShare: 0.8, softShare: 0.85 })).toMatchObject({ confirmShare: 0.8, softShare: 0.85 })
})

test("settings: lowering softShare below the stored confirmShare clamps confirmShare instead of rejecting; softShare at or above hardShare is still rejected", () => {
  expect(normalizeGroupSettings({ softShare: 0.7 })).toMatchObject({ softShare: 0.7, confirmShare: 0.7 })
  expect(normalizeGroupSettings({ softShare: 0.95 }, { ...DEFAULT_GROUP_SETTINGS, hardShare: 0.99 })).toMatchObject({ softShare: 0.95, confirmShare: 0.9 })
  expect(() => normalizeGroupSettings({ softShare: 0.7, confirmShare: 0.8 })).toThrow("settings.confirmShare must not exceed softShare")
  expect(() => normalizeGroupSettings({ softShare: 0.95 })).toThrow("settings.softShare must be below hardShare")
})
