import type { TelemetrySettings, TelemetryUnit } from "../../api/telemetry"

/** Every field is text; limits and byte minimums are decimal gigabytes (1 GB = 1e9 bytes) for byte metrics. */
export interface SettingsForm {
  budgetMetric: string
  monthlyLimit: string
  pricePerGB: string
  freeGB: string
  surgeMetrics: string
  surgeFactor: string
  surgeMinGB: string
  surgeMinCount: string
  flagNonZeroMetrics: string
  checkMetrics: string
  staleAfterHours: string
  labels: string
  /** The unit the `monthlyLimit` text is written in: `bytes` means decimal GB, anything else (including unknown) is the raw number. */
  limitUnit: TelemetryUnit | null
}

/** The fields shown as text inputs. */
export type TextField = Exclude<keyof SettingsForm, "limitUnit">

export type FormResult = { ok: true; settings: TelemetrySettings } | { ok: false; field: TextField }

const GB = 1e9
const METRIC = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/
const DIM_KEY = /^[a-z][a-z0-9_]{0,31}$/

const text = (value: number | undefined, scale = 1) => value === undefined ? "" : String(parseFloat((value / scale).toFixed(9)))

function labelsToText(labels: TelemetrySettings["labels"]): string {
  const lines: string[] = []
  for (const dim of Object.keys(labels ?? {}).sort()) {
    const values = labels![dim]!
    for (const value of Object.keys(values).sort()) lines.push(`${dim}:${value}=${values[value]}`)
  }
  return lines.join("\n")
}

const limitText = (limit: number | undefined, unit: TelemetryUnit | null) => text(limit, unit === "bytes" ? GB : 1)

export function settingsToForm(settings: TelemetrySettings, budgetUnit: TelemetryUnit | null): SettingsForm {
  return {
    budgetMetric: settings.budgetMetric ?? "",
    monthlyLimit: limitText(settings.monthlyLimit, budgetUnit),
    limitUnit: budgetUnit,
    pricePerGB: text(settings.pricePerGB),
    freeGB: text(settings.freeGB),
    surgeMetrics: (settings.surgeMetrics ?? []).join(", "),
    surgeFactor: text(settings.surgeFactor),
    surgeMinGB: text(settings.surgeMinBytes, GB),
    surgeMinCount: text(settings.surgeMinCount),
    flagNonZeroMetrics: (settings.flagNonZeroMetrics ?? []).join(", "),
    checkMetrics: (settings.checkMetrics ?? []).join(", "),
    staleAfterHours: text(settings.staleAfterHours),
    labels: labelsToText(settings.labels),
  }
}

type Parsed<T> = { ok: true; value: T | undefined } | { ok: false }

function parseNumber(raw: string, rule: { min: number; max: number; integer?: boolean; above?: boolean }): Parsed<number> {
  const trimmed = raw.trim()
  if (trimmed === "") return { ok: true, value: undefined }
  const value = Number(trimmed)
  const low = rule.above ? value <= rule.min : value < rule.min
  if (!Number.isFinite(value) || low || value > rule.max || (rule.integer && !Number.isInteger(value))) return { ok: false }
  return { ok: true, value }
}

function parseList(raw: string, max: number): Parsed<string[]> {
  const items = [...new Set(raw.split(/[\s,]+/).filter(Boolean))]
  if (items.length === 0) return { ok: true, value: undefined }
  if (items.length > max || items.some(item => item.length > 64 || !METRIC.test(item))) return { ok: false }
  return { ok: true, value: items }
}

/** One `dimension:value=Name` per line; the value may contain colons (IPv6), the name may contain `=`. */
function parseLabels(raw: string): Parsed<Record<string, Record<string, string>>> {
  const labels: Record<string, Record<string, string>> = {}
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    const colon = trimmed.indexOf(":")
    const equals = colon < 0 ? -1 : trimmed.indexOf("=", colon + 1)
    if (colon < 1 || equals < 0) return { ok: false }
    const dim = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1, equals).trim()
    const name = trimmed.slice(equals + 1).trim()
    if (!DIM_KEY.test(dim) || value.length < 1 || value.length > 256 || name.length < 1 || name.length > 64) return { ok: false }
    ;(labels[dim] ??= {})[value] = name
  }
  const dims = Object.keys(labels)
  if (dims.length === 0) return { ok: true, value: undefined }
  return dims.length > 8 ? { ok: false } : { ok: true, value: labels }
}

export function formToSettings(form: SettingsForm): FormResult {
  const settings: TelemetrySettings = {}
  const budgetMetric = form.budgetMetric.trim()
  if (budgetMetric !== "") {
    if (budgetMetric.length > 64 || !METRIC.test(budgetMetric)) return { ok: false, field: "budgetMetric" }
    settings.budgetMetric = budgetMetric
  }
  const bytes = form.limitUnit === "bytes"
  const limit = parseNumber(form.monthlyLimit, { min: 0, above: true, max: bytes ? 1e6 : 1e15 })
  if (!limit.ok) return { ok: false, field: "monthlyLimit" }
  if (limit.value !== undefined) settings.monthlyLimit = bytes ? Math.round(limit.value * GB) : limit.value
  const price = parseNumber(form.pricePerGB, { min: 0, max: 1e6 })
  if (!price.ok) return { ok: false, field: "pricePerGB" }
  if (price.value !== undefined) settings.pricePerGB = price.value
  const free = parseNumber(form.freeGB, { min: 0, max: 1e9 })
  if (!free.ok) return { ok: false, field: "freeGB" }
  if (free.value !== undefined) settings.freeGB = free.value
  const surge = parseList(form.surgeMetrics, 10)
  if (!surge.ok) return { ok: false, field: "surgeMetrics" }
  if (surge.value) settings.surgeMetrics = surge.value
  const factor = parseNumber(form.surgeFactor, { min: 1, above: true, max: 1000 })
  if (!factor.ok) return { ok: false, field: "surgeFactor" }
  if (factor.value !== undefined) settings.surgeFactor = factor.value
  const minGb = parseNumber(form.surgeMinGB, { min: 0, max: 1e6 })
  if (!minGb.ok) return { ok: false, field: "surgeMinGB" }
  if (minGb.value !== undefined) settings.surgeMinBytes = Math.round(minGb.value * GB)
  const minCount = parseNumber(form.surgeMinCount, { min: 0, max: 1e15 })
  if (!minCount.ok) return { ok: false, field: "surgeMinCount" }
  if (minCount.value !== undefined) settings.surgeMinCount = minCount.value
  const flags = parseList(form.flagNonZeroMetrics, 20)
  if (!flags.ok) return { ok: false, field: "flagNonZeroMetrics" }
  if (flags.value) settings.flagNonZeroMetrics = flags.value
  const checks = parseList(form.checkMetrics, 20)
  if (!checks.ok) return { ok: false, field: "checkMetrics" }
  if (checks.value) settings.checkMetrics = checks.value
  const stale = parseNumber(form.staleAfterHours, { min: 1, max: 720, integer: true })
  if (!stale.ok) return { ok: false, field: "staleAfterHours" }
  if (stale.value !== undefined) settings.staleAfterHours = stale.value
  const labels = parseLabels(form.labels)
  if (!labels.ok) return { ok: false, field: "labels" }
  if (labels.value) settings.labels = labels.value
  return { ok: true, settings }
}

export interface FormSource { id: string; settings: string }

/** Edits are kept across a rename and the metrics finishing their load; they are replaced when another source opens or the saved settings change. */
export function shouldResetForm(prev: FormSource, next: FormSource): boolean {
  return prev.id !== next.id || prev.settings !== next.settings
}

/**
 * When the unit of the budget metric becomes known (or changes), rewrite only the limit from the stored settings in that unit,
 * unless the limit itself was edited: then its text and unit stay as they are. Returns the same object when nothing changes.
 */
export function reconcileLimit(form: SettingsForm, stored: TelemetrySettings, unit: TelemetryUnit | null, limitEdited: boolean): SettingsForm {
  if (form.limitUnit === unit || limitEdited) return form
  return { ...form, monthlyLimit: limitText(stored.monthlyLimit, unit), limitUnit: unit }
}

/** Typing in the limit field; clearing it lets the limit be entered afresh in the current budget metric's unit. */
export function editLimit(form: SettingsForm, value: string, metricUnit: TelemetryUnit | null): SettingsForm {
  return { ...form, monthlyLimit: value, limitUnit: value.trim() === "" ? metricUnit : form.limitUnit }
}

export type LimitState = "loading" | "ready" | "raw" | "mismatch"

/** `loading`: the units are not loaded yet; `raw`: the budget metric has no known unit, so the limit is a raw number; `mismatch`: the text is in another unit than the metric's. */
export function limitState(form: SettingsForm, metricUnit: TelemetryUnit | null, metricsLoaded: boolean): LimitState {
  if (!metricsLoaded) return "loading"
  if (form.monthlyLimit.trim() !== "" && form.limitUnit !== metricUnit) return "mismatch"
  return metricUnit === null && form.monthlyLimit.trim() !== "" ? "raw" : "ready"
}
