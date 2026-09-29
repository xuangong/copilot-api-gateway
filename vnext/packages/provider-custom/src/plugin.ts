import type { LlmProviderPlugin } from '@vibe-llm/provider-llm'
import { CustomProvider, type CustomProviderConfig } from './provider'

export const customProviderPlugin: LlmProviderPlugin = {
  kind: 'custom',
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
