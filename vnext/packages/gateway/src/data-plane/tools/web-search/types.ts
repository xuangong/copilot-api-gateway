// Ported 1:1 from copilot-gateway data-plane/tools/web-search/types.ts

import type { WebSearchProviderName } from '../../../shared/web-search-providers.ts'
import type { MessagesWebSearchErrorCode } from '@vibe-llm/protocols/messages'

export type { WebSearchProviderName } from '../../../shared/web-search-providers.ts'

export const DEFAULT_WEB_SEARCH_RESULT_COUNT = 10

// Hard cap (UTF-8 bytes) on a single page returned by `fetchPage`. The shim's
// downstream function_call_output strings carry this content, so the cap keeps
// model-visible tool output bounded regardless of upstream page size. Same cap
// for every provider so the shim's truncation handling is provider-agnostic.
export const MAX_FETCH_PAGE_BYTES = 10_240

export type WebSearchProviderErrorCode = Exclude<MessagesWebSearchErrorCode, 'max_uses_exceeded'>

export interface WebSearchProviderRequest {
  query: string
  allowedDomains?: string[]
  blockedDomains?: string[]
  userLocation?: {
    city?: string
    region?: string
    country?: string
    timezone?: string
  }
  /** When undefined, the provider applies its own default count. */
  maxResults?: number
  /** Aborted when the downstream client disconnects — providers MUST pass
   *  through to the underlying fetch so cancellation stops upstream load. */
  signal?: AbortSignal
}

export type WebSearchProviderResult =
  | {
      type: 'ok'
      results: Array<{
        source: string
        title: string
        pageAge?: string
        content: Array<{ type: 'text'; text: string }>
      }>
    }
  | {
      type: 'error'
      errorCode: WebSearchProviderErrorCode
      message?: string
    }

export interface WebSearchPreviewResult {
  title: string
  url: string
  pageAge?: string
  previewText: string
}

export interface WebSearchFetchPageRequest {
  urls: string[]
  /** See WebSearchProviderRequest.signal. */
  signal?: AbortSignal
}

export type WebSearchFetchPageResult =
  | {
      type: 'ok'
      pages: Array<{
        url: string
        title?: string
        content: string
        truncated: boolean
        fullContentBytes: number
      }>
      failures: Array<{
        url: string
        errorCode: WebSearchProviderErrorCode
        message?: string
      }>
    }
  | {
      type: 'error'
      errorCode: WebSearchProviderErrorCode
      message?: string
    }

export interface WebSearchProvider {
  search(request: WebSearchProviderRequest): Promise<WebSearchProviderResult>
  fetchPage(request: WebSearchFetchPageRequest): Promise<WebSearchFetchPageResult>
}

export type ConfiguredWebSearchProvider =
  | { type: 'disabled' }
  | { type: 'missing-credential'; provider: WebSearchProviderName }
  | {
      type: 'enabled'
      provider: WebSearchProviderName
      impl: WebSearchProvider
    }

export type SearchConfigConnectionTestResult =
  | {
      ok: true
      provider: WebSearchProviderName
      query: string
      results: WebSearchPreviewResult[]
    }
  | {
      ok: false
      provider: WebSearchProviderName
      query: string
      error: { code: string; message: string }
    }
