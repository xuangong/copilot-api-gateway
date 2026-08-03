// Ported 1:1 from copilot-gateway data-plane/tools/web-search/search.ts

import type { WebSearchProvider, WebSearchProviderName, WebSearchProviderRequest, WebSearchProviderResult } from './types.ts'
import { recordSearchUsage } from './usage.ts'
import type { ApiKeyId } from '../../../shared/repo/branded-ids.ts'

export const searchWebAndRecordUsage = async (opts: {
  provider: WebSearchProvider
  providerName: WebSearchProviderName
  keyId: ApiKeyId
  request: WebSearchProviderRequest
}): Promise<WebSearchProviderResult> => {
  try {
    return await opts.provider.search(opts.request)
  } finally {
    try {
      await recordSearchUsage({
        provider: opts.providerName,
        keyId: opts.keyId,
        action: 'search',
      })
    } catch (error) {
      console.error('Web search usage record error:', error)
    }
  }
}
