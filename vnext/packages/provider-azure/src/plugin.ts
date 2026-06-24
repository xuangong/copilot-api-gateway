import type { LlmProviderPlugin } from '@vnext-llm/provider-llm'
import { AzureProvider, type AzureProviderConfig } from './provider'

export const azureProviderPlugin: LlmProviderPlugin = {
  kind: 'azure',
  async createFromUpstream(upstream) {
    return new AzureProvider(upstream.config as unknown as AzureProviderConfig)
  },
}
