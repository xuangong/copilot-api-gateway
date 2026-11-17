// packages/gateway/tests/protection-settings.test.ts
import { expect, test } from "bun:test"
import { DEFAULT_PROTECTION_SETTINGS, PROTECTION_LIMITS } from "../src/repo/protection"
import { ProtectionSettingsError, normalizeProtection, resolveProtection } from "../src/protection/settings"

test("an empty object leaves the current settings; a partial object merges onto them", () => {
  expect(normalizeProtection({})).toEqual(DEFAULT_PROTECTION_SETTINGS)
  const current = { ...DEFAULT_PROTECTION_SETTINGS, mode: "notify" as const, windowMinutes: 10 }
  expect(normalizeProtection({ minRiskyErrors: 7 }, current)).toEqual({ ...current, minRiskyErrors: 7 })
  expect(normalizeProtection({ mode: "pause" }, current).windowMinutes).toBe(10)
})

test("every numeric field accepts its bounds and rejects just outside them", () => {
  for (const [field, [min, max]] of Object.entries(PROTECTION_LIMITS)) {
    const base = { ...DEFAULT_PROTECTION_SETTINGS, cooldownMinutes: 1, maxCooldownMinutes: 10080 }
    expect(normalizeProtection({ [field]: min }, base)[field as keyof typeof base], `${field} min`).toBe(min)
    expect(normalizeProtection({ [field]: max }, base)[field as keyof typeof base], `${field} max`).toBe(max)
    const step = Number.isInteger(min) && Number.isInteger(max) && field !== "minFailureRatio" && field !== "keyShare" ? 1 : 0.01
    expect(() => normalizeProtection({ [field]: min - step }, base), `${field} below`).toThrow(ProtectionSettingsError)
    expect(() => normalizeProtection({ [field]: max + step }, base), `${field} above`).toThrow(ProtectionSettingsError)
  }
})

test("minutes and counts must be integers; ratios may be fractions; non-numbers are refused", () => {
  expect(() => normalizeProtection({ windowMinutes: 2.5 })).toThrow(ProtectionSettingsError)
  expect(() => normalizeProtection({ authBurst: 1.5 })).toThrow(ProtectionSettingsError)
  expect(normalizeProtection({ minFailureRatio: 0.333 }).minFailureRatio).toBe(0.333)
  expect(normalizeProtection({ authBurst: 0 }).authBurst).toBe(0)
  for (const bad of ["5", null, Number.NaN, Infinity, [], {}]) expect(() => normalizeProtection({ windowMinutes: bad })).toThrow(ProtectionSettingsError)
})

test("mode, unknown keys, the cooldown ordering and non-objects are refused without echoing input", () => {
  expect(() => normalizeProtection({ mode: "ban" })).toThrow(ProtectionSettingsError)
  expect(() => normalizeProtection({ secretToken: "sk-FAKEFAKEFAKE0000" })).toThrow("unknown protection setting")
  expect(() => normalizeProtection({ cooldownMinutes: 100, maxCooldownMinutes: 50 })).toThrow("maxCooldownMinutes")
  for (const bad of [null, "x", 1, []]) expect(() => normalizeProtection(bad)).toThrow(ProtectionSettingsError)
  try { normalizeProtection({ mode: "sk-FAKEFAKEFAKE0000" }) } catch (error) { expect(String(error)).not.toContain("sk-FAKE") }
})

test("stored JSON is read leniently: invalid fields fall back to their defaults", () => {
  expect(resolveProtection(null)).toEqual(DEFAULT_PROTECTION_SETTINGS)
  expect(resolveProtection("nope")).toEqual(DEFAULT_PROTECTION_SETTINGS)
  expect(resolveProtection({ mode: "pause", windowMinutes: 999, minRiskyErrors: 3, extra: true }))
    .toEqual({ ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", minRiskyErrors: 3 })
  expect(resolveProtection({ cooldownMinutes: 100, maxCooldownMinutes: 50 }).maxCooldownMinutes).toBe(100)
})
