import { configRecord, parseOpaqueCompatibilityMap, pickScalars, withHttpCredentialFields, type LlmProviderPlugin } from '@vibe-llm/provider-llm'
import { BILLING_DIMENSIONS } from '@vibe-llm/protocols/common'
import { parseCustomChatMetadata } from './config'

function publicModels(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(entry => {
    if (typeof entry === 'string') return entry
    const source = configRecord(entry)
    const out = pickScalars(source, ['id', 'name', 'ownedBy', 'upstreamModelId'])
    if (source.cost) out.cost = Object.fromEntries(Object.entries(pickScalars(source.cost, BILLING_DIMENSIONS)).filter(([, cost]) => typeof cost === 'number'))
    if (source.chat) {
      try { out.chat = parseCustomChatMetadata(source.chat) } catch { /* Invalid stored metadata grants no public fields. */ }
    }
    return out
  })
}
import { CustomProvider, type CustomProviderConfig } from './provider'
import { normalizeCustomConfig } from './config'

export const customProviderPlugin: LlmProviderPlugin = {
  kind: 'custom',
  normalizeConfig: config => normalizeCustomConfig(config) as unknown as Record<string, unknown>,
  probeConfig: async config => await new CustomProvider(normalizeCustomConfig(config)).probe(),
  publicConfig: source => {
    const out = pickScalars(source, ['name', 'baseUrl', 'authStyle', 'modelsEndpoint'])
    if (source.pathOverrides) out.pathOverrides = pickScalars(source.pathOverrides, ['chat_completions', 'responses', 'messages', 'embeddings', 'images_generations', 'images_edits', 'alpha_search'])
    if (source.models) out.models = publicModels(source.models)
    return withHttpCredentialFields(out, source, parseOpaqueCompatibilityMap)
  },
  async createFromUpstream(upstream, ctx) {
    const executionFactory = ctx.executionFetcherForUpstream
    return new CustomProvider(
      upstream.config as unknown as CustomProviderConfig,
      ctx.fetcherForUpstream?.(upstream.id),
      executionFactory ? request => executionFactory(upstream.id, request) : undefined,
      ctx.affinityAuthority,
    )
  },
}
