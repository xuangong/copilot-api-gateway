import type { LlmProviderPlugin } from '@vibe-llm/provider-llm'
import { SdfProvider, type SdfProviderConfig } from './provider'

export const sdfProviderPlugin: LlmProviderPlugin = {
  kind: 'sdf',
  async createFromUpstream(upstream, ctx) {
    const executionFactory = ctx.executionFetcherForUpstream
    return new SdfProvider(
      upstream.config as unknown as SdfProviderConfig,
      ctx.fetcherForUpstream?.(upstream.id),
      executionFactory ? request => executionFactory(upstream.id, request) : undefined,
    )
  },
}
