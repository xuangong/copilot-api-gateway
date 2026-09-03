import type { ApiKeyRoutingPolicy } from '../../shared/api-key-model-mappings.ts'
import { parseModelRouting } from './model-routing.ts'

export interface ResolvedKeyModel {
  requestedModel: string
  routedModel: string
  upstreamPin?: string
  matchedRuleIndexes: number[]
}

export function resolveKeyModel(
  requestedModel: string,
  policy?: ApiKeyRoutingPolicy,
): ResolvedKeyModel {
  const { upstreamPin, bareModel } = parseModelRouting(requestedModel)
  if (!policy?.modelMappingsEnabled || policy.modelMappings.length === 0) {
    return {
      requestedModel,
      routedModel: requestedModel,
      ...(upstreamPin ? { upstreamPin } : {}),
      matchedRuleIndexes: [],
    }
  }

  let routedModel = bareModel
  const matchedRuleIndexes: number[] = []

  for (const [index, mapping] of policy.modelMappings.entries()) {
    if (mapping.source !== routedModel) continue
    routedModel = mapping.destination
    matchedRuleIndexes.push(index)
  }

  return {
    requestedModel,
    routedModel,
    ...(upstreamPin ? { upstreamPin } : {}),
    matchedRuleIndexes,
  }
}
