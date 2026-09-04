import type { ApiKeyModelMapping } from "../../api/keys"

export interface ModelMappingsState {
  enabled: boolean
  mappings: ApiKeyModelMapping[]
}

export interface DestinationInput {
  id: string
  upstreams: string[]
}

export interface DestinationChoice extends DestinationInput {
  unavailable: boolean
}

export type MappingValidationCode = "blank" | "too_long" | "too_many" | "unavailable"

export interface MappingValidationError {
  index: number
  field: "source" | "destination" | "mappings"
  code: MappingValidationCode
}

export function initialModelMappingsState(server: Pick<ModelMappingsState, "enabled" | "mappings"> | {
  model_mappings_enabled: boolean
  model_mappings: ApiKeyModelMapping[]
}): ModelMappingsState {
  if ("enabled" in server) {
    return { enabled: server.enabled, mappings: server.mappings.map((mapping) => ({ ...mapping })) }
  }
  return {
    enabled: server.model_mappings_enabled,
    mappings: server.model_mappings.map((mapping) => ({ ...mapping })),
  }
}

export function addMapping(mappings: ApiKeyModelMapping[]): ApiKeyModelMapping[] {
  return [...mappings, { source: "", destination: "" }]
}

export function deleteMapping(mappings: ApiKeyModelMapping[], index: number): ApiKeyModelMapping[] {
  if (index < 0 || index >= mappings.length) return mappings
  return mappings.filter((_, itemIndex) => itemIndex !== index)
}

export function moveMapping(mappings: ApiKeyModelMapping[], index: number, delta: number): ApiKeyModelMapping[] {
  const target = index + delta
  if (index < 0 || target < 0 || index >= mappings.length || target >= mappings.length) return mappings
  const next = [...mappings]
  const current = next[index]
  const replacement = next[target]
  if (!current || !replacement) return mappings
  next[index] = replacement
  next[target] = current
  return next
}

export function isModelMappingsDirty(
  state: ModelMappingsState,
  server: Pick<ModelMappingsState, "enabled" | "mappings"> | {
    model_mappings_enabled: boolean
    model_mappings: ApiKeyModelMapping[]
  },
): boolean {
  const initial = initialModelMappingsState(server)
  return state.enabled !== initial.enabled || state.mappings.some((mapping, index) =>
    mapping.source !== initial.mappings[index]?.source || mapping.destination !== initial.mappings[index]?.destination,
  ) || state.mappings.length !== initial.mappings.length
}

export function buildDestinationChoices(inputs: DestinationInput[], savedDestinations: string[]): DestinationChoice[] {
  const choices = new Map<string, DestinationChoice>()
  for (const input of inputs) {
    const existing = choices.get(input.id)
    if (existing) {
      existing.upstreams = [...new Set([...existing.upstreams, ...input.upstreams])].sort((a, b) => a.localeCompare(b))
    } else {
      choices.set(input.id, { id: input.id, upstreams: [...new Set(input.upstreams)].sort((a, b) => a.localeCompare(b)), unavailable: false })
    }
  }
  for (const id of savedDestinations) {
    if (!choices.has(id)) choices.set(id, { id, upstreams: [], unavailable: true })
  }
  return [...choices.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function validateModelMappings(
  mappings: ApiKeyModelMapping[],
  availableDestinations: ReadonlySet<string>,
): MappingValidationError[] {
  if (mappings.length > 100) return [{ index: 100, field: "mappings", code: "too_many" }]
  const errors: MappingValidationError[] = []
  mappings.forEach((mapping, index) => {
    for (const field of ["source", "destination"] as const) {
      const value = mapping[field]
      if (!value.trim()) errors.push({ index, field, code: "blank" })
      else if (value.length > 256) errors.push({ index, field, code: "too_long" })
      else if (field === "destination" && !availableDestinations.has(value)) {
        errors.push({ index, field, code: "unavailable" })
      }
    }
  })
  return errors
}
