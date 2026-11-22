import type { GroupSettings } from "../../../api/upstream-groups"
import { shareToPercent } from "../../../state/quota-format"

/** Mirrors `DEFAULT_GROUP_SETTINGS` / `GROUP_SETTINGS_LIMITS` in the gateway (a gateway test fails if they drift). */
export const GROUP_DEFAULTS: GroupSettings = {
  toleranceShare: 0.05, softShare: 0.9, hardShare: 0.95, idleRebalanceMinutes: 10, migrateShare: 0.1, burnHorizonHours: 6, heavySessionUsdPerHour: 5,
  migrateMinHours: 12, exhaustedPolicy: "stop", readIntervalHours: 6, confirmShare: 0.9, driftShare: 0.1, sessionIdleHours: 24,
}
export const GROUP_LIMITS = {
  toleranceShare: [0, 0.5], softShare: [0.5, 1], hardShare: [0.5, 1], idleRebalanceMinutes: [1, 1440], migrateShare: [0.01, 1], burnHorizonHours: [0, 72],
  heavySessionUsdPerHour: [0, 10000], migrateMinHours: [0, 720], readIntervalHours: [1, 48], confirmShare: [0.5, 1], driftShare: [0.01, 1], sessionIdleHours: [1, 720],
} as const

export type NumericField = keyof typeof GROUP_LIMITS
export const NUMERIC_FIELDS = Object.keys(GROUP_LIMITS) as NumericField[]
const SHARE_FIELDS: ReadonlySet<NumericField> = new Set<NumericField>(["toleranceShare", "softShare", "hardShare", "migrateShare", "confirmShare", "driftShare"])
const INTEGER_FIELDS: ReadonlySet<NumericField> = new Set<NumericField>(["idleRebalanceMinutes", "sessionIdleHours"])

export interface GroupForm { policy: GroupSettings["exhaustedPolicy"]; values: Record<NumericField, string> }
export type FieldErrorKind = "number" | "integer" | "range" | "order" | "confirmOrder"
export type FieldErrors = Partial<Record<NumericField, FieldErrorKind>>

const toDisplay = (field: NumericField, value: number): string => String(SHARE_FIELDS.has(field) ? shareToPercent(value) : value)
/** The range as the user sees it: percent for shares. */
export const displayRange = (field: NumericField): [number, number] => {
  const [min, max] = GROUP_LIMITS[field]
  return SHARE_FIELDS.has(field) ? [shareToPercent(min), shareToPercent(max)] : [min, max]
}
export const defaultText = (field: NumericField): string => toDisplay(field, GROUP_DEFAULTS[field])

export const toForm = (settings: GroupSettings): GroupForm => ({
  policy: settings.exhaustedPolicy,
  values: Object.fromEntries(NUMERIC_FIELDS.map(field => [field, toDisplay(field, settings[field])])) as Record<NumericField, string>,
})

export function parseForm(form: GroupForm): { ok: true; settings: GroupSettings } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {}
  const settings: GroupSettings = { ...GROUP_DEFAULTS, exhaustedPolicy: form.policy }
  for (const field of NUMERIC_FIELDS) {
    const text = form.values[field].trim()
    const shown = text === "" ? Number.NaN : Number(text)
    const [min, max] = displayRange(field)
    if (!Number.isFinite(shown)) errors[field] = "number"
    else if (INTEGER_FIELDS.has(field) && !Number.isInteger(shown)) errors[field] = "integer"
    else if (shown < min || shown > max) errors[field] = "range"
    else settings[field] = SHARE_FIELDS.has(field) ? Math.round(shown * 1e4) / 1e6 : shown
  }
  // The server's rules: the soft line is strictly below the hard line, and the confirming read is at or below the soft line.
  if (!errors.softShare && !errors.hardShare && settings.softShare >= settings.hardShare) errors.softShare = "order"
  if (!errors.softShare && !errors.confirmShare && settings.confirmShare > settings.softShare) errors.confirmShare = "confirmOrder"
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, settings }
}

/**
 * Sets one field's text. Lowering the soft line below the confirming-read value moves that value down with it (as the server does: it never blocks
 * on this); a half-typed or invalid soft line changes nothing else.
 */
export function setFieldValue(form: GroupForm, field: NumericField, value: string): GroupForm {
  const values = { ...form.values, [field]: value }
  if (field === "softShare") {
    const soft = value.trim() === "" ? Number.NaN : Number(value)
    const confirm = Number(values.confirmShare)
    const [min, max] = displayRange("softShare")
    if (Number.isFinite(soft) && soft >= min && soft <= max && Number.isFinite(confirm) && soft < confirm) values.confirmShare = value.trim()
  }
  return { ...form, values }
}

export const resetToDefaults = (form: GroupForm): GroupForm => ({ ...toForm(GROUP_DEFAULTS), policy: form.policy })

export function isDirty(form: GroupForm, saved: GroupSettings): boolean {
  const base = toForm(saved)
  return base.policy !== form.policy || NUMERIC_FIELDS.some(field => base.values[field] !== form.values[field].trim())
}
