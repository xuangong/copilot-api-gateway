import type { LlmProviderPlugin } from '@vibe-llm/provider-llm'
import { AzureProvider, type AzureProviderConfig } from './provider'

export const azureProviderPlugin: LlmProviderPlugin = {
  kind: 'azure',
  async createFromUpstream(upstream, ctx) {
    return new AzureProvider(
      upstream.config as unknown as AzureProviderConfig,
      ctx.fetcherForUpstream?.(upstream.id),
    )
  },
}
