import type { TelemetrySettings } from "../../api/telemetry"

const DIM_KEY = /^[a-z][a-z0-9_]{0,31}$/
const MAX_DIMS = 8

export type LabelResult = { ok: true; settings: TelemetrySettings } | { ok: false; reason: "name" | "value" | "limit" }

/**
 * The settings with `name` as the display name of `dimKey` = `value`, under the limits the settings form and the gateway enforce
 * (dimension key pattern, value 1-256 characters, name 1-64, at most 8 named dimensions). An empty name removes the label. Pure.
 */
export function withLabel(settings: TelemetrySettings, dimKey: string, value: string, name: string): LabelResult {
  const trimmed = name.trim()
  if (!DIM_KEY.test(dimKey) || value.length < 1 || value.length > 256) return { ok: false, reason: "value" }
  if (trimmed.length > 64) return { ok: false, reason: "name" }
  const labels: Record<string, Record<string, string>> = {}
  for (const [key, values] of Object.entries(settings.labels ?? {})) labels[key] = { ...values }
  if (trimmed === "") {
    if (labels[dimKey]) {
      delete labels[dimKey][value]
      if (Object.keys(labels[dimKey]).length === 0) delete labels[dimKey]
    }
  } else {
    if (!labels[dimKey] && Object.keys(labels).length >= MAX_DIMS) return { ok: false, reason: "limit" }
    ;(labels[dimKey] ??= {})[value] = trimmed
  }
  const { labels: _previous, ...rest } = settings
  return { ok: true, settings: Object.keys(labels).length === 0 ? rest : { ...rest, labels } }
}
