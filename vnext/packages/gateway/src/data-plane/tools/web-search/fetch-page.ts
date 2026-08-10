// Ported 1:1 from copilot-gateway data-plane/tools/web-search/fetch-page.ts

import type { WebSearchFetchPageRequest, WebSearchFetchPageResult, WebSearchProvider, WebSearchProviderName } from './types.ts'
import { recordSearchUsage } from './usage.ts'
import type { ApiKeyId } from '../../../repo/branded-ids.ts'

export const fetchPageAndRecordUsage = async (args: {
  provider: WebSearchProvider
  providerName: WebSearchProviderName
  keyId: ApiKeyId
  request: WebSearchFetchPageRequest
}): Promise<WebSearchFetchPageResult> => {
  try {
    return await args.provider.fetchPage(args.request)
  } finally {
    try {
      await recordSearchUsage({
        provider: args.providerName,
        keyId: args.keyId,
        action: 'fetch_page',
        // Provider billing is per URL; the shim batches URLs into one call
        // but each URL must increment its own usage row.
        requests: args.request.urls.length,
      })
    } catch (error) {
      console.error('Web search usage record error:', error)
    }
  }
}
