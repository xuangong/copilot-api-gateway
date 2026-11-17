// apps/dashboard/src/tabs/upstreams/protection/protection-form.test.ts
import { expect, test } from "bun:test"
import { NUMERIC_FIELDS, PROTECTION_DEFAULTS, PROTECTION_LIMITS, isDirty, parseForm, resetToDefaults, toForm } from "./protection-form"

test("the form round-trips the settings as text", () => {
  const form = toForm({ ...PROTECTION_DEFAULTS, mode: "pause", minFailureRatio: 0.25 })
  expect(form.mode).toBe("pause")
  expect(form.values.minFailureRatio).toBe("0.25")
  const parsed = parseForm(form)
  expect(parsed).toEqual({ ok: true, settings: { ...PROTECTION_DEFAULTS, mode: "pause", minFailureRatio: 0.25 } })
})

test("every field accepts its bounds and rejects just outside them", () => {
  for (const field of NUMERIC_FIELDS) {
    const [min, max] = PROTECTION_LIMITS[field]
    const base = { ...toForm({ ...PROTECTION_DEFAULTS, cooldownMinutes: 1, maxCooldownMinutes: 10080 }) }
    const at = (value: number) => parseForm({ ...base, values: { ...base.values, [field]: String(value) } })
    expect(at(min), `${field} min`).toMatchObject({ ok: true })
    expect(at(max), `${field} max`).toMatchObject({ ok: true })
    const step = ["minFailureRatio", "keyShare"].includes(field) ? 0.01 : 1
    expect(at(min - step), `${field} below`).toMatchObject({ ok: false, errors: { [field]: "range" } })
    expect(at(max + step), `${field} above`).toMatchObject({ ok: false, errors: { [field]: "range" } })
  }
})

test("empty, non-numeric and fractional-integer inputs are reported per field", () => {
  const form = toForm(PROTECTION_DEFAULTS)
  expect(parseForm({ ...form, values: { ...form.values, windowMinutes: "" } })).toMatchObject({ ok: false, errors: { windowMinutes: "number" } })
  expect(parseForm({ ...form, values: { ...form.values, authBurst: "abc" } })).toMatchObject({ ok: false, errors: { authBurst: "number" } })
  expect(parseForm({ ...form, values: { ...form.values, minRiskyErrors: "2.5" } })).toMatchObject({ ok: false, errors: { minRiskyErrors: "integer" } })
  expect(parseForm({ ...form, values: { ...form.values, authBurst: "0" } })).toMatchObject({ ok: true }) // 0 disables the burst rule
})

test("the maximum cooldown must not be below the cooldown", () => {
  const form = toForm({ ...PROTECTION_DEFAULTS, cooldownMinutes: 100, maxCooldownMinutes: 50 })
  expect(parseForm(form)).toEqual({ ok: false, errors: { maxCooldownMinutes: "order" } })
})

test("reset restores the defaults but keeps the chosen mode; dirty tracks edits", () => {
  const saved = { ...PROTECTION_DEFAULTS, mode: "notify" as const, windowMinutes: 10 }
  const form = toForm(saved)
  expect(isDirty(form, saved)).toBe(false)
  expect(isDirty({ ...form, values: { ...form.values, windowMinutes: " 10 " } }, saved)).toBe(false)
  expect(isDirty({ ...form, mode: "pause" }, saved)).toBe(true)
  const reset = resetToDefaults(form)
  expect(reset.mode).toBe("notify")
  expect(reset.values.windowMinutes).toBe("5")
  expect(isDirty(reset, saved)).toBe(true)
})

test("a reload that brings the same settings keeps the user's edits; a changed value resets a clean form only", async () => {
  const { reconcileForm } = await import("./protection-form")
  const prev = { ...PROTECTION_DEFAULTS, windowMinutes: 10 }
  const edited = { ...toForm(prev), values: { ...toForm(prev).values, windowMinutes: "12" } }
  // New object identity, same value: nothing changes, edits stay.
  expect(reconcileForm(edited, prev, { ...prev })).toBe(edited)
  // Changed elsewhere while the form is dirty: keep the edits.
  expect(reconcileForm(edited, prev, { ...prev, mode: "pause" })).toBe(edited)
  // Changed while clean: follow it.
  const clean = toForm(prev)
  expect(reconcileForm(clean, prev, { ...prev, mode: "pause" })).toEqual(toForm({ ...prev, mode: "pause" }))
})

test("save failures map protection.<field> messages onto that field", async () => {
  const { saveFailure } = await import("./protection-form")
  const { ApiError } = await import("../../../api/client")
  const fail = (status: number, message: string) => saveFailure(new ApiError(status, null, message))
  expect(fail(400, "protection.windowMinutes must be an integer between 1 and 60")).toEqual({ fieldErrors: { windowMinutes: "range" }, message: null })
  expect(fail(400, "protection.maxCooldownMinutes must not be below cooldownMinutes")).toEqual({ fieldErrors: { maxCooldownMinutes: "order" }, message: null })
  // Not a field: show the server's words for 400 and 403, generic otherwise.
  expect(fail(400, "protection.mode must be off, notify or pause")).toEqual({ fieldErrors: {}, message: "protection.mode must be off, notify or pause" })
  expect(fail(403, "Not your upstream")).toEqual({ fieldErrors: {}, message: "Not your upstream" })
  expect(fail(500, "boom")).toEqual({ fieldErrors: {}, message: null })
  expect(saveFailure(new TypeError("fetch failed"))).toEqual({ fieldErrors: {}, message: null })
})
