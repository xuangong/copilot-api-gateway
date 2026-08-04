/**
 * Codex-internal `/models` catalog assembler (vNext).
 *
 * codex CLI reads this shape via `OpenAiModelsManager::list_models` and
 * replaces its bundled catalog when the auth mode is Chatgpt /
 * ChatgptAuthTokens / AgentIdentity. The wire shape is codex's own
 * `ModelsResponse` (`{"models":[ModelInfo,...]}`), NOT the OpenAI public
 * catalog (`{"object":"list","data":[...]}`) served at `/v1/models` for
 * everyone else.
 *
 * Pipeline (vNext port):
 *   1. Resolve the exact-client-version Codex catalog via `resolveCodexCatalog`
 *      (in-memory cache → GitHub `raw.githubusercontent.com` tag fetch →
 *      bundled fallback).
 *   2. Segment-match each addressable vNext model id against the resolved
 *      catalog (walk `/`- and `:`-separated segments from leaf back to prefix
 *      so `openrouter/gpt-5.5/gpt-5.4` binds against `gpt-5.4`).
 *   3. Feed each (vNext model row, matched catalog entry?, capabilities) to
 *      `synthesizeCatalogEntry` — reference project's field precedence rules.
 *
 * Reference: copilot-gateway `data-plane/codex/models.ts`. vNext delta: no
 * `enumerateAddressableModelIds` (vNext has no prefix-addressable-alternate
 * concept in the data plane), so we drive off the same `listUpstreamModels`
 * data OpenAI-shaped `/v1/models` already consumes. Non-chat rows (embeddings,
 * images) are filtered out here — Codex only speaks chat/responses.
 */
import {
  resolveCodexCatalog,
  type CatalogModel,
  type CodexCatalog,
  type CodexCatalogCapabilities,
} from './catalog.ts'
import { synthesizeCatalogEntry, type CodexSynthesizeModel } from './synthesize.ts'

interface VNextModelRow extends CodexSynthesizeModel {
  capabilities?: {
    type?: string
    limits?: {
      max_context_window_tokens?: number
    }
  }
}

const isChatRow = (m: VNextModelRow): boolean => {
  const capType = m.capabilities?.type?.toLowerCase()
  if (!capType) return true
  return (
    capType !== 'embedding'
    && capType !== 'embeddings'
    && capType !== 'image'
    && capType !== 'images'
  )
}

/**
 * Pure transformation: client catalog + vNext model rows → Codex-shaped
 * catalog. Extracted for testability without standing up the fetch pipeline.
 */
export const assembleCodexCatalog = (
  catalog: CodexCatalog,
  models: readonly VNextModelRow[],
  capabilities: CodexCatalogCapabilities = {},
): CodexCatalog => {
  const catalogBySlug = new Map<string, CatalogModel>()
  for (const model of catalog.models) catalogBySlug.set(model.slug.toLowerCase(), model)

  const matchCatalog = (publicId: string): CatalogModel | undefined => {
    const segments = publicId.toLowerCase().split(/[/:]/)
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]
      if (seg === undefined) continue
      const hit = catalogBySlug.get(seg)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  const out: CatalogModel[] = []
  for (const row of models) {
    if (!isChatRow(row)) continue
    out.push(synthesizeCatalogEntry(row, matchCatalog(row.id), capabilities))
  }
  return { models: out }
}

export const loadCodexCatalog = async (
  userAgent: string | undefined,
  models: readonly VNextModelRow[],
): Promise<CodexCatalog> => {
  const resolution = await resolveCodexCatalog(userAgent)
  return assembleCodexCatalog(resolution.catalog, models, resolution.capabilities)
}
