// packages/gateway/src/quota-balance/settings.ts
import { DEFAULT_GROUP_SETTINGS, GROUP_NUMERIC_FIELDS, GROUP_SETTINGS_LIMITS, type GroupNumericField, type GroupSettings } from "../repo/quota-balance.ts"

export { resolveGroupSettings } from "../repo/quota-balance.ts"
export class GroupSettingsError extends Error {}

const INTEGER = new Set<GroupNumericField>(["idleRebalanceMinutes", "sessionIdleHours"])
const fieldOk = (field: GroupNumericField, value: unknown): value is number => {
  const [min, max] = GROUP_SETTINGS_LIMITS[field]
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!INTEGER.has(field) || Number.isInteger(value))
}

/**
 * Strict validation for the API: unknown keys and out-of-range values throw; absent keys keep their value from `current`.
 * Messages name fields and ranges, never the submitted value.
 */
export function normalizeGroupSettings(input: unknown, current: GroupSettings = DEFAULT_GROUP_SETTINGS): GroupSettings {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new GroupSettingsError("settings must be an object")
  const raw = input as Record<string, unknown>
  const known = new Set<string>(["exhaustedPolicy", ...GROUP_NUMERIC_FIELDS])
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new GroupSettingsError("unknown group setting")
  const out: GroupSettings = { ...current }
  if (raw.exhaustedPolicy !== undefined) {
    if (raw.exhaustedPolicy !== "stop" && raw.exhaustedPolicy !== "overage") throw new GroupSettingsError("settings.exhaustedPolicy must be stop or overage")
    out.exhaustedPolicy = raw.exhaustedPolicy
  }
  for (const field of GROUP_NUMERIC_FIELDS) {
    const value = raw[field]
    if (value === undefined) continue
    if (!fieldOk(field, value)) {
      const [min, max] = GROUP_SETTINGS_LIMITS[field]
      throw new GroupSettingsError(`settings.${field} must be ${INTEGER.has(field) ? "an integer" : "a number"} between ${min} and ${max}`)
    }
    out[field] = value
  }
  if (out.softShare >= out.hardShare) throw new GroupSettingsError("settings.softShare must be below hardShare")
  // Lowering softShare below the stored confirmShare moves confirmShare down with it; an explicitly submitted contradiction is still rejected.
  if (out.confirmShare > out.softShare && raw.confirmShare === undefined) out.confirmShare = out.softShare
  if (out.confirmShare > out.softShare) throw new GroupSettingsError("settings.confirmShare must not exceed softShare")
  return out
}
