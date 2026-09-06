import { parseCompositeModelId, type Model, type ModelsResponse } from "@vibe-llm/provider-copilot"
import type { ApiKeyRoutingPolicy } from "../../shared/api-key-model-mappings.ts"
import { resolveKeyModel } from "../routing/key-model-mapping.ts"

type CatalogModel = Model & { _upstream?: string; _mapped_to?: string }

/** Project key aliases after loading the upstream catalog so caches stay key-independent. */
export function withKeyModelAliases(
  models: ModelsResponse,
  policy?: ApiKeyRoutingPolicy,
  dedupe = true,
): ModelsResponse {
  if (!policy?.modelMappingsEnabled || policy.modelMappings.length === 0) return models

  const identity = (model: CatalogModel) => JSON.stringify([model.id, dedupe ? null : model._upstream])
  const raw: CatalogModel[] = models.data
  const data = [...raw]
  const seen = new Set(data.map(identity))
  const sources = new Set(policy.modelMappings.map(({ source }) => source))

  for (const source of sources) {
    const resolved = resolveKeyModel(source, policy)
    if (resolved.matchedRuleIndexes.length === 0) continue
    const candidates = raw.filter(
      (model) => !resolved.upstreamPin || model._upstream === resolved.upstreamPin,
    )
    const direct = candidates.filter((model) => model.id === resolved.routedModel)
    const baseId = parseCompositeModelId(resolved.routedModel).baseId
    const targets = direct.length > 0 ? direct : candidates.filter((model) => model.id === baseId)
    for (const target of targets) {
      const alias: CatalogModel = {
        ...target,
        id: source,
        name: source,
        // Mapping sources match exactly; target variants do not create new source aliases.
        available_combinations: undefined,
        _mapped_to: resolved.routedModel,
      }
      const key = identity(alias)
      if (seen.has(key)) continue
      seen.add(key)
      data.push(alias)
    }
  }

  return { ...models, data }
}
