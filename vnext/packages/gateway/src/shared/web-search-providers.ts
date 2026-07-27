// Ported 1:1 from copilot-gateway packages/gateway/src/shared/web-search-providers.ts.
//
// Canonical provider-name list + SearchConfig shape used by the web-search
// reference stack (tavily / microsoft-grounding / jina). vNext's own
// engine registry (bing/copilot/langsearch) adapts INTO this abstraction
// in Phase 13-C-5 — this file must stay 1:1 with the reference so the
// ported plugin code compiles unchanged.

export const WEB_SEARCH_PROVIDER_NAMES = ['tavily', 'microsoft-grounding', 'jina'] as const

export type WebSearchProviderName = (typeof WEB_SEARCH_PROVIDER_NAMES)[number]

export interface SearchConfig {
  provider: 'disabled' | WebSearchProviderName
  tavily: { apiKey: string }
  microsoftGrounding: { apiKey: string }
  jina: { apiKey: string }
  passthroughOpenAiSearch: {
    enabled: boolean
    upstreamId: string
    model: string
  }
}

const WEB_SEARCH_PROVIDER_NAME_SET = new Set<string>(WEB_SEARCH_PROVIDER_NAMES)

export const isWebSearchProviderName = (value: unknown): value is WebSearchProviderName =>
  typeof value === 'string' && WEB_SEARCH_PROVIDER_NAME_SET.has(value)

export const assertWebSearchProviderName = (value: unknown): WebSearchProviderName => {
  if (isWebSearchProviderName(value)) return value
  throw new TypeError(`Invalid web search provider: ${String(value)}`)
}
