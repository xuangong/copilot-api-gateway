export interface ApiKeyModelMapping {
  source: string
  destination: string
}

export interface ApiKeyRoutingPolicy {
  modelMappingsEnabled: boolean
  modelMappings: readonly ApiKeyModelMapping[]
}

export const MAX_MODEL_MAPPINGS = 100
export const MAX_MODEL_NAME_LENGTH = 256

export const DEFAULT_API_KEY_MODEL_MAPPINGS: readonly ApiKeyModelMapping[] = Object.freeze([
  Object.freeze({ source: 'gpt-5.6-sol', destination: 'gpt-5.6-sol-fast' }),
])

export type ModelMappingsInvalidReason =
  | 'not_array'
  | 'invalid_item'
  | 'invalid_field'
  | 'empty_field'
  | 'field_too_long'
  | 'too_many_items'
  | 'invalid_json'

export type ModelMappingsNormalizationResult =
  | { ok: true; value: ApiKeyModelMapping[] }
  | {
    ok: false
    reason: ModelMappingsInvalidReason
    index?: number
    field?: 'source' | 'destination'
  }

export function normalizeApiKeyModelMappings(value: unknown): ModelMappingsNormalizationResult {
  if (!Array.isArray(value)) return { ok: false, reason: 'not_array' }
  if (value.length > MAX_MODEL_MAPPINGS) return { ok: false, reason: 'too_many_items' }

  const mappings: ApiKeyModelMapping[] = []
  for (let index = 0; index < value.length; index++) {
    const item = value[index]
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: 'invalid_item', index }
    }

    const mapping = item as Record<string, unknown>
    for (const field of ['source', 'destination'] as const) {
      const raw = mapping[field]
      if (typeof raw !== 'string') return { ok: false, reason: 'invalid_field', index, field }
      const normalized = raw.trim()
      if (!normalized) return { ok: false, reason: 'empty_field', index, field }
      if (normalized.length > MAX_MODEL_NAME_LENGTH) {
        return { ok: false, reason: 'field_too_long', index, field }
      }
    }

    mappings.push({
      source: (mapping.source as string).trim(),
      destination: (mapping.destination as string).trim(),
    })
  }

  return { ok: true, value: mappings }
}

export function parseStoredApiKeyModelMappings(value: string): ModelMappingsNormalizationResult {
  try {
    return normalizeApiKeyModelMappings(JSON.parse(value))
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
}
