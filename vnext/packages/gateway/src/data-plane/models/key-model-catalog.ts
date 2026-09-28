import { parseCompositeModelId, type Model, type ModelsResponse } from "@vibe-llm/provider-copilot"
import type { ApiKeyRoutingPolicy } from "../../shared/api-key-model-mappings.ts"
import { resolveKeyModel } from "../routing/key-model-mapping.ts"
import { supportsOriginalImageDetail } from '../providers/catalog-image-detail.ts'

type CatalogModel = Model & {
  _upstream?: string
  _mapped_to?: string
  chat?: { image_detail_original?: boolean; modalities?: { input?: string[] } }
}

/** Collapse public ids only after route-specific aliases have selected targets. */
export function collapseModelCatalog(models: ModelsResponse): ModelsResponse {
  const data: CatalogModel[] = []
  const positions = new Map<string, number>()
  for (const row of models.data as CatalogModel[]) {
    const position = positions.get(row.id)
    if (position === undefined) {
      positions.set(row.id, data.length)
      data.push({ ...row, ...(row.chat ? { chat: {
        ...row.chat, image_detail_original: supportsOriginalImageDetail(row),
      } } : {}) })
      continue
    }
    const retained = data[position]
    if (retained) retained.chat = {
      ...retained.chat,
      image_detail_original: supportsOriginalImageDetail(retained)
        && supportsOriginalImageDetail(row),
    }
  }
  return { ...models, data }
}

/** Project key aliases after loading the upstream catalog so caches stay key-independent. */
export function withKeyModelAliases(
  models: ModelsResponse,
  policy?: ApiKeyRoutingPolicy,
  dedupe = true,
): ModelsResponse {
  if (!policy?.modelMappingsEnabled || policy.modelMappings.length === 0) {
    return dedupe ? collapseModelCatalog(models) : models
  }

  const identity = (model: CatalogModel) => JSON.stringify([model.id, model._upstream])
  const raw: CatalogModel[] = models.data
  const sources = new Set(policy.modelMappings.map(({ source }) => source))
  const resolutions = [...sources].map((source) => ({ source, resolved: resolveKeyModel(source, policy) }))
  // A redirected request id must describe its callable targets, even when an
  // upstream also publishes that id. Self-maps still expose the original row.
  const redirectedSources = new Set(resolutions
    .filter(({ source, resolved }) => resolved.matchedRuleIndexes.length > 0 && resolved.routedModel !== source)
    .map(({ source }) => source))
  const data = raw.filter((model) => !redirectedSources.has(model.id))
  const seen = new Set(data.map(identity))

  for (const { source, resolved } of resolutions) {
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

  const projected = { ...models, data }
  return dedupe ? collapseModelCatalog(projected) : projected
}
