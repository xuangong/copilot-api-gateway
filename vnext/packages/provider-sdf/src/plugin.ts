import type { LlmProviderPlugin } from '@vibe-llm/provider-llm'
import { SdfProvider, type SdfProviderConfig } from './provider'

export const sdfProviderPlugin: LlmProviderPlugin = {
  kind: 'sdf',
  async createFromUpstream(upstream) {
    return new SdfProvider(upstream.config as unknown as SdfProviderConfig)
  },
}
