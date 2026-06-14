import type { ProviderPlugin } from '@vnext/provider'
import { AzureProvider, type AzureProviderConfig } from './provider'

export const azureProviderPlugin: ProviderPlugin = {
  kind: 'azure',
  async createFromUpstream(upstream) {
    return new AzureProvider(upstream.config as unknown as AzureProviderConfig)
  },
}
