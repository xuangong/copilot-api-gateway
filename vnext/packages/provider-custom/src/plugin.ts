import type { ProviderPlugin } from '@vnext-llm/provider'
import { CustomProvider, type CustomProviderConfig } from './provider'

export const customProviderPlugin: ProviderPlugin = {
  kind: 'custom',
  async createFromUpstream(upstream) {
    return new CustomProvider(upstream.config as unknown as CustomProviderConfig)
  },
}
