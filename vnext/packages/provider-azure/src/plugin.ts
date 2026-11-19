import { pickScalars, withHttpCredentialFields, type LlmProviderPlugin } from '@vibe-llm/provider-llm'
import { normalizeAzureConfig, parseAzureOpaqueCompatibility } from './config'
import { AzureProvider, type AzureProviderConfig } from './provider'

export const azureProviderPlugin: LlmProviderPlugin = {
  kind: 'azure',
  normalizeConfig: config => normalizeAzureConfig(config) as unknown as Record<string, unknown>,
  probeConfig: async config => await new AzureProvider(normalizeAzureConfig(config) as AzureProviderConfig).probe(),
  publicConfig: source => {
    const out = pickScalars(source, ['name', 'endpoint', 'deployment', 'apiVersion'])
    if (Array.isArray(source.deployments)) out.deployments = source.deployments.map(entry => pickScalars(entry, ['name', 'model']))
    return withHttpCredentialFields(out, source, parseAzureOpaqueCompatibility)
  },
  async createFromUpstream(upstream, ctx) {
    const executionFactory = ctx.executionFetcherForUpstream
    return new AzureProvider(
      upstream.config as unknown as AzureProviderConfig,
      ctx.fetcherForUpstream?.(upstream.id),
      executionFactory ? request => executionFactory(upstream.id, request) : undefined,
      ctx.affinityAuthority,
    )
  },
}
