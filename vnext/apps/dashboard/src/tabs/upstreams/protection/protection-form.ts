// apps/dashboard/src/tabs/upstreams/protection/protection-form.ts
import { ApiError } from "../../../api/client"
import type { ProtectionMode, ProtectionSettings } from "../../../api/protection"

/** Mirrors `DEFAULT_PROTECTION_SETTINGS` / `PROTECTION_LIMITS` in the gateway (a gateway test fails if they drift). */
export const PROTECTION_DEFAULTS: ProtectionSettings = {
  mode: "off", windowMinutes: 5, minRiskyErrors: 20, minFailureRatio: 0.5, authBurst: 5, keyShare: 0.8, cooldownMinutes: 30, maxCooldownMinutes: 360,
}
export const PROTECTION_LIMITS = {
  windowMinutes: [1, 60], minRiskyErrors: [1, 10000], minFailureRatio: [0, 1], authBurst: [0, 10000],
  keyShare: [0.5, 1], cooldownMinutes: [1, 1440], maxCooldownMinutes: [1, 10080],
} as const

export type NumericField = keyof typeof PROTECTION_LIMITS
export const NUMERIC_FIELDS = Object.keys(PROTECTION_LIMITS) as NumericField[]
export const INTEGER_FIELDS: ReadonlySet<NumericField> = new Set<NumericField>(["windowMinutes", "minRiskyErrors", "authBurst", "cooldownMinutes", "maxCooldownMinutes"])

/** Inputs are text while editing; `parseForm` turns them into settings or per-field errors. */
export interface ProtectionForm { mode: ProtectionMode; values: Record<NumericField, string> }
export type FieldErrorKind = "number" | "integer" | "range" | "order"
export type FieldErrors = Partial<Record<NumericField, FieldErrorKind>>

export const toForm = (settings: ProtectionSettings): ProtectionForm => ({
  mode: settings.mode,
  values: Object.fromEntries(NUMERIC_FIELDS.map((field) => [field, String(settings[field])])) as Record<NumericField, string>,
})

export function parseForm(form: ProtectionForm): { ok: true; settings: ProtectionSettings } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {}
  const settings: ProtectionSettings = { ...PROTECTION_DEFAULTS, mode: form.mode }
  for (const field of NUMERIC_FIELDS) {
    const text = form.values[field].trim()
    const value = text === "" ? Number.NaN : Number(text)
    const [min, max] = PROTECTION_LIMITS[field]
    if (!Number.isFinite(value)) errors[field] = "number"
    else if (INTEGER_FIELDS.has(field) && !Number.isInteger(value)) errors[field] = "integer"
    else if (value < min || value > max) errors[field] = "range"
    else settings[field] = value
  }
  if (!errors.cooldownMinutes && !errors.maxCooldownMinutes && settings.maxCooldownMinutes < settings.cooldownMinutes) errors.maxCooldownMinutes = "order"
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, settings }
}

/** Defaults for every threshold; the chosen mode stays. */
export const resetToDefaults = (form: ProtectionForm): ProtectionForm => ({ ...toForm(PROTECTION_DEFAULTS), mode: form.mode })

export function isDirty(form: ProtectionForm, saved: ProtectionSettings): boolean {
  const base = toForm(saved)
  return base.mode !== form.mode || NUMERIC_FIELDS.some((field) => base.values[field] !== form.values[field].trim())
}

const sameSettings = (a: ProtectionSettings, b: ProtectionSettings): boolean => JSON.stringify(toForm(a)) === JSON.stringify(toForm(b))

/**
 * The form after the saved settings were replaced (a list reload hands over a new object every time).
 * Same value: untouched. Changed value: follow it only while the user has no unsaved edits.
 */
export function reconcileForm(form: ProtectionForm, previous: ProtectionSettings, next: ProtectionSettings): ProtectionForm {
  if (sameSettings(previous, next)) return form
  return isDirty(form, previous) ? form : toForm(next)
}

const FIELD_MESSAGE = /^protection\.(\w+) (must be|must not be)/

/** What to show after a failed save: field errors for `protection.<field>` messages, else the server's words for 400/403, else generic (null). */
export function saveFailure(error: unknown): { fieldErrors: FieldErrors; message: string | null } {
  if (!(error instanceof ApiError)) return { fieldErrors: {}, message: null }
  if (error.status === 400) {
    const match = FIELD_MESSAGE.exec(error.message)
    const field = match?.[1] as NumericField | undefined
    if (match && field && field in PROTECTION_LIMITS) {
      return { fieldErrors: { [field]: match[2] === "must not be" ? "order" : "range" }, message: null }
    }
  }
  return { fieldErrors: {}, message: error.status === 400 || error.status === 403 ? error.message : null }
}
