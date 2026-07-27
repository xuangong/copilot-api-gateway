// Ported 1:1 from copilot-gateway data-plane/tools/web-search/provider.ts.

import { createBingWebSearchProvider } from './providers/bing.ts'
import { createCopilotWebSearchProvider } from './providers/copilot.ts'
import { createJinaWebSearchProvider } from './providers/jina.ts'
import { createLangSearchWebSearchProvider } from './providers/langsearch.ts'
import { createMicrosoftGroundingWebSearchProvider } from './providers/microsoft-grounding.ts'
import { createTavilyWebSearchProvider } from './providers/tavily.ts'
import { FIXED_SEARCH_CONFIG_TEST_QUERY } from './search-config.ts'
import type { ConfiguredWebSearchProvider, SearchConfig, SearchConfigConnectionTestResult, WebSearchProvider, WebSearchProviderName } from './types.ts'

const toPreviewText = (content: Array<{ type: 'text'; text: string }>): string =>
  content
    .map(block => block.text)
    .join('\n')
    .slice(0, 280)

// Per-provider lookup: pulls the credential out of the config slot for
// that provider and constructs the impl. Keeps `resolveConfiguredWeb...`
// data-driven so adding a fourth provider is one entry, not another
// if-branch.
const PROVIDER_FACTORIES: { [N in WebSearchProviderName]: (config: SearchConfig) => { apiKey: string; build: (apiKey: string) => WebSearchProvider } } = {
  tavily: config => ({ apiKey: config.tavily.apiKey, build: createTavilyWebSearchProvider }),
  'microsoft-grounding': config => ({ apiKey: config.microsoftGrounding.apiKey, build: createMicrosoftGroundingWebSearchProvider }),
  jina: config => ({ apiKey: config.jina.apiKey, build: createJinaWebSearchProvider }),
  // Bing SERP scrape has no first-party API key. Use a fixed sentinel so
  // the resolver's `missing-credential` guard passes when the user opts
  // in to the bing provider.
  bing: _config => ({ apiKey: 'bing-public-scrape', build: createBingWebSearchProvider }),
  copilot: config => ({ apiKey: config.copilot.githubToken, build: createCopilotWebSearchProvider }),
  langsearch: config => ({ apiKey: config.langsearch.apiKey, build: createLangSearchWebSearchProvider }),
}

export const resolveConfiguredWebSearchProvider = (config: SearchConfig): ConfiguredWebSearchProvider => {
  if (config.provider === 'disabled') {
    return { type: 'disabled' }
  }

  const factory = PROVIDER_FACTORIES[config.provider](config)
  if (!factory.apiKey) {
    return { type: 'missing-credential', provider: config.provider }
  }

  return {
    type: 'enabled',
    provider: config.provider,
    impl: factory.build(factory.apiKey),
  }
}

export const testSearchConfigConnection = async (config: SearchConfig): Promise<SearchConfigConnectionTestResult> => {
  const resolved = resolveConfiguredWebSearchProvider(config)

  if (resolved.type === 'disabled') {
    return {
      ok: false,
      provider: 'disabled',
      query: FIXED_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: 'disabled',
        message: 'Search provider is disabled.',
      },
    }
  }

  if (resolved.type === 'missing-credential') {
    return {
      ok: false,
      provider: resolved.provider,
      query: FIXED_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: 'missing_credential',
        message: `Missing API key for ${resolved.provider}.`,
      },
    }
  }

  const result = await resolved.impl.search({ query: FIXED_SEARCH_CONFIG_TEST_QUERY })

  if (result.type === 'error') {
    return {
      ok: false,
      provider: resolved.provider,
      query: FIXED_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: result.errorCode,
        message: result.message ?? 'Search test failed.',
      },
    }
  }

  const previews = result.results.slice(0, 3).map(entry => ({
    title: entry.title,
    url: entry.source,
    pageAge: entry.pageAge,
    previewText: toPreviewText(entry.content),
  }))

  if (previews.length === 0) {
    return {
      ok: false,
      provider: resolved.provider,
      query: FIXED_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: 'no_results',
        message: 'Search returned no preview results.',
      },
    }
  }

  return {
    ok: true,
    provider: resolved.provider,
    query: FIXED_SEARCH_CONFIG_TEST_QUERY,
    results: previews,
  }
}
