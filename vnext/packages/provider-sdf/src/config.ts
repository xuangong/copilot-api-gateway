/**
 * Validation of a submitted SDF upstream config (create / edit / probe).
 * Owned here so the gateway does not need to know SDF's legal values.
 */
import type { SdfProviderConfig } from './provider'

/**
 * Upstream rejects an unknown value with a 400 that names the legal set, so
 * mirror those sets here — a typo in the dashboard should fail at save time
 * rather than on the first image request.
 */
const SDF_EXPERIENCES = ['BizChat', 'WXPOAgents', 'AppCopilots', 'Cowork', 'Scout', 'WorkIQ']
const SDF_SERVICE_TIERS = ['async', 'async-express', 'flex', 'default', 'priority']
const SDF_TRAFFIC_TYPES = ['Production', 'Test']

function optionalEnum(
  value: unknown,
  allowed: readonly string[],
  field: string,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`sdf config.${field} must be one of: ${allowed.join(', ')}`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

export function normalizeSdfConfig(config: Record<string, unknown>): SdfProviderConfig {
  if (typeof config.name !== 'string' || !config.name.trim()) throw new Error('sdf config.name required')
  if (typeof config.substrateToken !== 'string' || !config.substrateToken) {
    throw new Error('sdf config.substrateToken required')
  }
  const taxonomy = (config.taxonomy ?? {}) as Record<string, unknown>
  const cos = (config.cos ?? {}) as Record<string, unknown>
  const passport = (config.passport ?? {}) as Record<string, unknown>

  const apiBase = optionalString(passport.apiBase)
  if (apiBase && !apiBase.startsWith('https://')) {
    throw new Error('sdf config.passport.apiBase must be https')
  }

  const out: SdfProviderConfig = {
    name: config.name.trim(),
    substrateToken: config.substrateToken,
  }
  const normalizedTaxonomy = stripUndefined({
    experience: optionalEnum(taxonomy.experience, SDF_EXPERIENCES, 'taxonomy.experience'),
    agent: optionalString(taxonomy.agent),
    inferenceStep: optionalString(taxonomy.inferenceStep),
    trafficType: optionalEnum(taxonomy.trafficType, SDF_TRAFFIC_TYPES, 'taxonomy.trafficType') as
      | 'Production'
      | 'Test'
      | undefined,
  })
  if (normalizedTaxonomy) out.taxonomy = normalizedTaxonomy
  const normalizedCos = stripUndefined({
    serviceTier: optionalEnum(cos.serviceTier, SDF_SERVICE_TIERS, 'cos.serviceTier'),
  })
  if (normalizedCos) out.cos = normalizedCos
  const normalizedPassport = stripUndefined({
    enabled: typeof passport.enabled === 'boolean' ? passport.enabled : undefined,
    apiBase,
  })
  if (normalizedPassport) out.passport = normalizedPassport
  return out
}

/** Drop unset keys so an all-empty form doesn't persist `{}` sub-objects. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined)
  return entries.length ? (Object.fromEntries(entries) as T) : undefined
}

