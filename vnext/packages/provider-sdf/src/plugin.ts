import { maskSecret, pickScalars, type LlmProviderPlugin } from '@vibe-llm/provider-llm'
import { SdfProvider, type SdfProviderConfig } from './provider'
import { normalizeSdfConfig } from './config'

export const sdfProviderPlugin: LlmProviderPlugin = {
  kind: 'sdf',
  normalizeConfig: config => normalizeSdfConfig(config) as unknown as Record<string, unknown>,
  probeConfig: async config => await new SdfProvider(normalizeSdfConfig(config)).probe(),
  publicConfig: source => {
    const out = pickScalars(source, ['name'])
    maskSecret(out, source, 'substrateToken')
    if (source.taxonomy) out.taxonomy = pickScalars(source.taxonomy, ['experience', 'agent', 'inferenceStep', 'trafficType'])
    if (source.cos) out.cos = pickScalars(source.cos, ['serviceTier'])
    if (source.passport) out.passport = pickScalars(source.passport, ['enabled', 'apiBase'])
    return out
  },
  async createFromUpstream(upstream, ctx) {
    const executionFactory = ctx.executionFetcherForUpstream
    return new SdfProvider(
      upstream.config as unknown as SdfProviderConfig,
      ctx.fetcherForUpstream?.(upstream.id),
      executionFactory ? request => executionFactory(upstream.id, request) : undefined,
    )
  },
}
