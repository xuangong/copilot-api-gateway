// packages/gateway/src/protection/settings.ts
import { DEFAULT_PROTECTION_SETTINGS, PROTECTION_LIMITS, type ProtectionMode, type ProtectionSettings } from "../repo/protection.ts"

export class ProtectionSettingsError extends Error {}

type NumericField = keyof typeof PROTECTION_LIMITS
const NUMERIC = Object.keys(PROTECTION_LIMITS) as NumericField[]
const INTEGER = new Set<NumericField>(["windowMinutes", "minRiskyErrors", "authBurst", "cooldownMinutes", "maxCooldownMinutes"])
const MODES: readonly ProtectionMode[] = ["off", "notify", "pause"]

const fieldOk = (field: NumericField, value: unknown): value is number => {
  const [min, max] = PROTECTION_LIMITS[field]
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!INTEGER.has(field) || Number.isInteger(value))
}

/**
 * Strict validation for the PATCH route: unknown keys and out-of-range values throw. Keys that are absent keep
 * their value from `current`. Error messages name fields and ranges, never the submitted value.
 */
export function normalizeProtection(input: unknown, current: ProtectionSettings = DEFAULT_PROTECTION_SETTINGS): ProtectionSettings {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ProtectionSettingsError("protection must be an object")
  const raw = input as Record<string, unknown>
  const known = new Set<string>(["mode", ...NUMERIC])
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new ProtectionSettingsError("unknown protection setting")
  const out: ProtectionSettings = { ...current }
  if (raw.mode !== undefined) {
    if (!MODES.includes(raw.mode as ProtectionMode)) throw new ProtectionSettingsError("protection.mode must be off, notify or pause")
    out.mode = raw.mode as ProtectionMode
  }
  for (const field of NUMERIC) {
    const value = raw[field]
    if (value === undefined) continue
    if (!fieldOk(field, value)) {
      const [min, max] = PROTECTION_LIMITS[field]
      throw new ProtectionSettingsError(`protection.${field} must be ${INTEGER.has(field) ? "an integer" : "a number"} between ${min} and ${max}`)
    }
    out[field] = value
  }
  if (out.maxCooldownMinutes < out.cooldownMinutes) throw new ProtectionSettingsError("protection.maxCooldownMinutes must not be below cooldownMinutes")
  return out
}

/** Lenient read of stored JSON: an invalid or missing field takes its default; never throws. */
export function resolveProtection(raw: unknown): ProtectionSettings {
  const out: ProtectionSettings = { ...DEFAULT_PROTECTION_SETTINGS }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out
  const stored = raw as Record<string, unknown>
  if (MODES.includes(stored.mode as ProtectionMode)) out.mode = stored.mode as ProtectionMode
  for (const field of NUMERIC) {
    const value = stored[field]
    if (fieldOk(field, value)) out[field] = value
  }
  if (out.maxCooldownMinutes < out.cooldownMinutes) out.maxCooldownMinutes = out.cooldownMinutes
  return out
}
