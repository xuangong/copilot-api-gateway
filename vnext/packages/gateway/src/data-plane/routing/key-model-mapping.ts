import type { ApiKeyRoutingPolicy } from '../../shared/api-key-model-mappings.ts'
import { parseModelRouting } from './binding-resolver.ts'

export interface ResolvedKeyModel {
  requestedModel: string
  routedModel: string
  upstreamPin?: string
  matchedRuleIndexes: number[]
}

export function resolveKeyModel(
  requestedModel: string,
  policy: ApiKeyRoutingPolicy,
): ResolvedKeyModel {
  if (!policy.modelMappingsEnabled || policy.modelMappings.length === 0) {
    return { requestedModel, routedModel: requestedModel, matchedRuleIndexes: [] }
  }

  const { upstreamPin, bareModel } = parseModelRouting(requestedModel)
  let routedModel = bareModel
  const matchedRuleIndexes: number[] = []

  for (const [index, mapping] of policy.modelMappings.entries()) {
    if (mapping.source !== routedModel) continue
    routedModel = mapping.destination
    matchedRuleIndexes.push(index)
  }

  return {
    requestedModel,
    routedModel: upstreamPin ? `${upstreamPin}/${routedModel}` : routedModel,
    ...(upstreamPin ? { upstreamPin } : {}),
    matchedRuleIndexes,
  }
}
