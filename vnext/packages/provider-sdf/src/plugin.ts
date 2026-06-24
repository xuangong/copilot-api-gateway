import type { ProviderPlugin } from '@vnext-llm/provider'
import { SdfProvider, type SdfProviderConfig } from './provider'

export const sdfProviderPlugin: ProviderPlugin = {
  kind: 'sdf',
  async createFromUpstream(upstream) {
    return new SdfProvider(upstream.config as unknown as SdfProviderConfig)
  },
}
