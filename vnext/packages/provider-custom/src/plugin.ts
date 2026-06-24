import type { LlmProviderPlugin } from '@vnext-llm/provider-llm'
import { CustomProvider, type CustomProviderConfig } from './provider'

export const customProviderPlugin: LlmProviderPlugin = {
  kind: 'custom',
  async createFromUpstream(upstream) {
    return new CustomProvider(upstream.config as unknown as CustomProviderConfig)
  },
}
