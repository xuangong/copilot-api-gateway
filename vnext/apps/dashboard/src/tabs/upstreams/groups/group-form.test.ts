import { expect, test } from "bun:test"
import { GROUP_DEFAULTS, isDirty, parseForm, resetToDefaults, setFieldValue, toForm, displayRange } from "./group-form"

test("shares are edited as percentages, everything else as stored", () => {
  const form = toForm(GROUP_DEFAULTS)
  expect(form.values.softShare).toBe("90")
  expect(form.values.toleranceShare).toBe("5")
  expect(form.values.idleRebalanceMinutes).toBe("10")
  expect(form.policy).toBe("stop")
  expect(displayRange("softShare")).toEqual([50, 100])
  expect(displayRange("readIntervalHours")).toEqual([1, 48])
})

test("a valid form converts back to settings", () => {
  const form = toForm(GROUP_DEFAULTS)
  form.values.hardShare = "98"
  form.values.heavySessionUsdPerHour = "0"
  form.policy = "overage"
  expect(parseForm(form)).toEqual({ ok: true, settings: { ...GROUP_DEFAULTS, hardShare: 0.98, heavySessionUsdPerHour: 0, exhaustedPolicy: "overage" } })
})

test("each field reports what is wrong with it; the soft line must not exceed the hard line", () => {
  const form = toForm(GROUP_DEFAULTS)
  form.values.toleranceShare = "abc"
  form.values.idleRebalanceMinutes = "2.5"
  form.values.readIntervalHours = "99"
  form.values.softShare = "97"
  expect(parseForm(form)).toEqual({ ok: false, errors: { toleranceShare: "number", idleRebalanceMinutes: "integer", readIntervalHours: "range", softShare: "order" } })
})

test("dirty tracking and reset keep the chosen policy out of the way", () => {
  const form = toForm(GROUP_DEFAULTS)
  expect(isDirty(form, GROUP_DEFAULTS)).toBe(false)
  expect(isDirty({ ...form, policy: "overage" }, GROUP_DEFAULTS)).toBe(true)
  const edited = { ...form, values: { ...form.values, driftShare: "20" } }
  expect(isDirty(edited, GROUP_DEFAULTS)).toBe(true)
  expect(resetToDefaults({ ...edited, policy: "overage" })).toEqual({ ...toForm(GROUP_DEFAULTS), policy: "overage" })
})

test("the soft line must be strictly below the hard line, as the server demands", () => {
  const form = toForm(GROUP_DEFAULTS)
  form.values.softShare = "95"
  expect(parseForm(form)).toEqual({ ok: false, errors: { softShare: "order" } })
})

test("lowering the soft line below the confirming read moves that field down with it (D28), and the form then saves", () => {
  const form = setFieldValue(toForm(GROUP_DEFAULTS), "softShare", "80")
  expect(form.values.softShare).toBe("80")
  expect(form.values.confirmShare).toBe("80")
  expect(parseForm(form)).toEqual({ ok: true, settings: { ...GROUP_DEFAULTS, softShare: 0.8, confirmShare: 0.8 } })
  // A confirm value already below the new soft line is left alone; so is a half-typed or invalid soft line.
  expect(setFieldValue({ ...toForm(GROUP_DEFAULTS), values: { ...toForm(GROUP_DEFAULTS).values, confirmShare: "60" } }, "softShare", "80").values.confirmShare).toBe("60")
  expect(setFieldValue(toForm(GROUP_DEFAULTS), "softShare", "8").values.confirmShare).toBe("90")
  expect(setFieldValue(toForm(GROUP_DEFAULTS), "softShare", "").values.confirmShare).toBe("90")
})

test("a confirming read typed above the soft line is an error on that field", () => {
  const form = setFieldValue(toForm(GROUP_DEFAULTS), "confirmShare", "92")
  expect(parseForm(form)).toEqual({ ok: false, errors: { confirmShare: "confirmOrder" } })
})
