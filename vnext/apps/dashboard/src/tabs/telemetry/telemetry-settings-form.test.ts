import { expect, test } from "bun:test"
import { editLimit, formToSettings, limitState, reconcileLimit, settingsToForm, shouldResetForm, type SettingsForm, type TextField } from "./telemetry-settings-form"

const empty = settingsToForm({}, null)

test("an empty form means no settings", () => {
  expect(formToSettings(empty)).toEqual({ ok: true, settings: {} })
})

test("settings round-trip through the form, with byte limits shown in decimal gigabytes", () => {
  const settings = {
    budgetMetric: "nic.tx_bytes", monthlyLimit: 500e9, pricePerGB: 0.08, freeGB: 100, surgeMetrics: ["nic.tx_bytes", "proxy.sent_bytes"], surgeFactor: 4,
    surgeMinBytes: 1.5e9, surgeMinCount: 500, flagNonZeroMetrics: ["probe.fail"], checkMetrics: ["probe.ok"], staleAfterHours: 3,
    labels: { domain: { "a.com": "A" }, user: { "#1": "MacBook", "#2": "Phone" } },
  }
  const form = settingsToForm(settings, "bytes")
  expect(form.monthlyLimit).toBe("500")
  expect(form.surgeMinGB).toBe("1.5")
  expect(form.labels).toBe("domain:a.com=A\nuser:#1=MacBook\nuser:#2=Phone")
  expect(formToSettings(form)).toEqual({ ok: true, settings })
})

test("a limit on a non-byte metric is used as is", () => {
  const form = { ...empty, budgetMetric: "proxy.connections", monthlyLimit: "5000" }
  expect(formToSettings(form)).toEqual({ ok: true, settings: { budgetMetric: "proxy.connections", monthlyLimit: 5000 } })
  expect(settingsToForm({ monthlyLimit: 5000 }, "count").monthlyLimit).toBe("5000")
})

test("lists accept commas and spaces and drop duplicates", () => {
  expect(formToSettings({ ...empty, surgeMetrics: "a.b, c  a.b\nd" })).toEqual({ ok: true, settings: { surgeMetrics: ["a.b", "c", "d"] } })
})

test.each<[Partial<SettingsForm>, TextField]>([
  [{ budgetMetric: "Bad Name" }, "budgetMetric"], [{ monthlyLimit: "0" }, "monthlyLimit"], [{ monthlyLimit: "abc" }, "monthlyLimit"],
  [{ pricePerGB: "-1" }, "pricePerGB"], [{ freeGB: "x" }, "freeGB"], [{ surgeFactor: "1" }, "surgeFactor"], [{ surgeFactor: "1001" }, "surgeFactor"],
  [{ surgeMinGB: "-2" }, "surgeMinGB"], [{ surgeMinCount: "1e99" }, "surgeMinCount"], [{ staleAfterHours: "0" }, "staleAfterHours"], [{ staleAfterHours: "2.5" }, "staleAfterHours"],
  [{ surgeMetrics: Array.from({ length: 11 }, (_, i) => `m${i}`).join(",") }, "surgeMetrics"],
  [{ flagNonZeroMetrics: Array.from({ length: 21 }, (_, i) => `m${i}`).join(",") }, "flagNonZeroMetrics"],
  [{ checkMetrics: "Bad-Name" }, "checkMetrics"],
  [{ labels: "no equals sign" }, "labels"], [{ labels: "user:=Empty value" }, "labels"], [{ labels: "Bad:x=y" }, "labels"], [{ labels: "user:x=" }, "labels"],
  [{ labels: "user:x=" + "y".repeat(65) }, "labels"],
])("%j is rejected at the field %s", (over, field) => {
  expect(formToSettings({ ...empty, ...over })).toEqual({ ok: false, field })
})

test("a label value may contain a colon, as an IPv6 address does", () => {
  expect(formToSettings({ ...empty, labels: "domain:2001:db8::1=Router" })).toEqual({ ok: true, settings: { labels: { domain: { "2001:db8::1": "Router" } } } })
})

test("the form is reset on a source switch or changed settings, never by the unit arriving", () => {
  const base = { id: "a", settings: "{}" }
  expect(shouldResetForm(base, { ...base })).toBe(false)
  expect(shouldResetForm(base, { ...base, id: "b" })).toBe(true)
  expect(shouldResetForm(base, { ...base, settings: '{"staleAfterHours":3}' })).toBe(true)
})

test("a limit shown before the unit is known is raw, and rewritten from the stored value when the unit arrives, even with other fields edited", () => {
  const stored = { budgetMetric: "nic.tx_bytes", monthlyLimit: 1234567, staleAfterHours: 3 }
  const early = settingsToForm(stored, null)
  expect(early.monthlyLimit).toBe("1234567")
  expect(early.limitUnit).toBeNull()
  const dirty = { ...early, staleAfterHours: "5" }
  const arrived = reconcileLimit(dirty, stored, "bytes", false)
  expect(arrived.monthlyLimit).toBe("0.001234567")
  expect(arrived.limitUnit).toBe("bytes")
  expect(arrived.staleAfterHours).toBe("5")
  const saved = formToSettings(arrived)
  expect(saved).toEqual({ ok: true, settings: { budgetMetric: "nic.tx_bytes", monthlyLimit: 1234567, staleAfterHours: 5 } })
  expect(reconcileLimit(arrived, stored, "bytes", false)).toBe(arrived)
})

test("an edited limit is kept with its own unit when the unit arrives", () => {
  const stored = { budgetMetric: "nic.tx_bytes", monthlyLimit: 500e9 }
  const edited = { ...settingsToForm(stored, null), monthlyLimit: "100" }
  expect(reconcileLimit(edited, stored, "bytes", true)).toBe(edited)
  expect(formToSettings(edited)).toEqual({ ok: true, settings: { budgetMetric: "nic.tx_bytes", monthlyLimit: 100 } })
})

test("the limit is blocked until the unit is known and flagged when the text is in another unit; an unknown-unit metric saves raw", () => {
  const stored = { budgetMetric: "nic.tx_bytes", monthlyLimit: 500e9 }
  const early = settingsToForm(stored, null)
  expect(limitState(early, null, false)).toBe("loading")
  expect(limitState(settingsToForm(stored, "bytes"), "bytes", true)).toBe("ready")
  expect(limitState(early, "bytes", true)).toBe("mismatch")
  expect(limitState({ ...early, monthlyLimit: "" }, "bytes", true)).toBe("ready")
  expect(limitState(early, null, true)).toBe("raw")
  expect(limitState(settingsToForm(stored, "bytes"), null, true)).toBe("mismatch")
  expect(formToSettings({ ...early, monthlyLimit: "250" })).toEqual({ ok: true, settings: { budgetMetric: "nic.tx_bytes", monthlyLimit: 250 } })
})

test("clearing an edited limit lets it adopt the new budget metric's unit, and typing again stays ready and is saved in that unit", () => {
  const stored = { budgetMetric: "nic.tx_bytes", monthlyLimit: 500e9 }
  const edited = editLimit(settingsToForm(stored, "bytes"), "200", "bytes")
  expect(edited.limitUnit).toBe("bytes")
  const switched = { ...edited, budgetMetric: "proxy.connections" }
  expect(limitState(switched, "count", true)).toBe("mismatch")
  const cleared = editLimit(switched, "", "count")
  expect(cleared.limitUnit).toBe("count")
  expect(limitState(cleared, "count", true)).toBe("ready")
  const retyped = editLimit(cleared, "5000", "count")
  expect(limitState(retyped, "count", true)).toBe("ready")
  expect(formToSettings(retyped)).toEqual({ ok: true, settings: { budgetMetric: "proxy.connections", monthlyLimit: 5000 } })
})
