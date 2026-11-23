import { expect, test } from "bun:test"
import { withLabel } from "./telemetry-labels"

test("naming a value adds it under its dimension and keeps the other settings and names", () => {
  const settings = { budgetMetric: "nic.tx_bytes", labels: { user: { "#1": "MacBook" } } }
  expect(withLabel(settings, "client", "1.2.3.4", "家里宽带")).toEqual({
    ok: true, settings: { budgetMetric: "nic.tx_bytes", labels: { user: { "#1": "MacBook" }, client: { "1.2.3.4": "家里宽带" } } },
  })
  expect(withLabel({}, "client", "2001:db8::1", " Router ")).toEqual({ ok: true, settings: { labels: { client: { "2001:db8::1": "Router" } } } })
  expect(settings.labels).toEqual({ user: { "#1": "MacBook" } })
})

test("renaming replaces and an empty name removes the label, dropping an emptied dimension", () => {
  const settings = { labels: { client: { "1.2.3.4": "Home" }, user: { "#1": "A" } } }
  expect(withLabel(settings, "client", "1.2.3.4", "Office")).toEqual({ ok: true, settings: { labels: { client: { "1.2.3.4": "Office" }, user: { "#1": "A" } } } })
  expect(withLabel(settings, "client", "1.2.3.4", "  ")).toEqual({ ok: true, settings: { labels: { user: { "#1": "A" } } } })
  expect(withLabel({ labels: { client: { "1.2.3.4": "Home" } } }, "client", "1.2.3.4", "")).toEqual({ ok: true, settings: {} })
})

test("names follow the same limits as the settings form", () => {
  expect(withLabel({}, "client", "x", "y".repeat(65))).toEqual({ ok: false, reason: "name" })
  expect(withLabel({}, "client", "x", "y".repeat(64)).ok).toBe(true)
  expect(withLabel({}, "Bad Key", "x", "y")).toEqual({ ok: false, reason: "value" })
  expect(withLabel({}, "client", "", "y")).toEqual({ ok: false, reason: "value" })
  expect(withLabel({}, "client", "v".repeat(257), "y")).toEqual({ ok: false, reason: "value" })
  const full = { labels: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`d${index}`, { a: "b" }])) }
  expect(withLabel(full, "client", "x", "y")).toEqual({ ok: false, reason: "limit" })
  expect(withLabel(full, "d3", "other", "y").ok).toBe(true)
})

test("what the form would produce from the new settings is accepted by the settings form", async () => {
  const { formToSettings, settingsToForm } = await import("./telemetry-settings-form")
  const result = withLabel({}, "client", "2001:db8::1", "a=b")
  if (!result.ok) throw new Error("expected ok")
  expect(formToSettings(settingsToForm(result.settings, null))).toEqual({ ok: true, settings: result.settings })
})
