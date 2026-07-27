// Ported 1:1 from copilot-gateway data-plane/tools/web-search/search-config.ts,
// with the isJsonObject helper inlined (vNext protocols don't export it).

import type { SearchConfig } from './types.ts'
import { getRepo } from '../../../shared/repo/index.ts'
import { WEB_SEARCH_PROVIDER_NAMES, isWebSearchProviderName } from '../../../shared/web-search-providers.ts'

type JsonObject = Record<string, unknown>
const isJsonObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  provider: 'disabled',
  tavily: { apiKey: '' },
  microsoftGrounding: { apiKey: '' },
  jina: { apiKey: '' },
  bing: { apiKey: '' },
  copilot: { githubToken: '' },
  langsearch: { apiKey: '' },
  passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
}

export const FIXED_SEARCH_CONFIG_TEST_QUERY = 'React documentation'

/** Fresh deep copy so callers can mutate without corrupting the singleton. */
export const parseSearchConfigDefault = (): SearchConfig => structuredClone(DEFAULT_SEARCH_CONFIG)

/** Strict parse: throws on malformed shape so persistence corruption surfaces
 *  instead of silently downgrading to `disabled`. */
export const parseSearchConfigStrict = (input: unknown): SearchConfig => {
  if (!isJsonObject(input)) {
    throw new Error('search config must be a JSON object')
  }
  if (input.provider !== 'disabled' && !isWebSearchProviderName(input.provider)) {
    const allowed = ['disabled', ...WEB_SEARCH_PROVIDER_NAMES].map(name => `'${name}'`).join(', ')
    throw new Error(`search config provider must be one of ${allowed}, got ${JSON.stringify(input.provider)}`)
  }
  if (!isJsonObject(input.tavily)) throw new Error('search config tavily must be an object')
  if (typeof input.tavily.apiKey !== 'string') throw new Error('search config tavily.apiKey must be a string')
  if (!isJsonObject(input.microsoftGrounding)) throw new Error('search config microsoftGrounding must be an object')
  if (typeof input.microsoftGrounding.apiKey !== 'string') throw new Error('search config microsoftGrounding.apiKey must be a string')
  if (!isJsonObject(input.jina)) throw new Error('search config jina must be an object')
  if (typeof input.jina.apiKey !== 'string') throw new Error('search config jina.apiKey must be a string')
  if (!isJsonObject(input.bing)) throw new Error('search config bing must be an object')
  if (typeof input.bing.apiKey !== 'string') throw new Error('search config bing.apiKey must be a string')
  if (!isJsonObject(input.copilot)) throw new Error('search config copilot must be an object')
  if (typeof input.copilot.githubToken !== 'string') throw new Error('search config copilot.githubToken must be a string')
  if (!isJsonObject(input.langsearch)) throw new Error('search config langsearch must be an object')
  if (typeof input.langsearch.apiKey !== 'string') throw new Error('search config langsearch.apiKey must be a string')
  if (!isJsonObject(input.passthroughOpenAiSearch)) throw new Error('search config passthroughOpenAiSearch must be an object')
  const passthrough = input.passthroughOpenAiSearch
  if (typeof passthrough.enabled !== 'boolean' || typeof passthrough.upstreamId !== 'string' || typeof passthrough.model !== 'string') {
    throw new Error('search config passthroughOpenAiSearch must contain enabled, upstreamId, and model')
  }
  const upstreamId = passthrough.upstreamId.trim()
  const model = passthrough.model.trim()
  if (passthrough.enabled && (upstreamId === '' || model === '')) {
    throw new Error('enabled OpenAI search passthrough requires an upstream and model')
  }
  return {
    provider: input.provider as SearchConfig['provider'],
    tavily: { apiKey: input.tavily.apiKey.trim() },
    microsoftGrounding: { apiKey: input.microsoftGrounding.apiKey.trim() },
    jina: { apiKey: input.jina.apiKey.trim() },
    bing: { apiKey: input.bing.apiKey.trim() },
    copilot: { githubToken: input.copilot.githubToken.trim() },
    langsearch: { apiKey: input.langsearch.apiKey.trim() },
    passthroughOpenAiSearch: { enabled: passthrough.enabled, upstreamId, model },
  }
}

export const loadSearchConfig = async (): Promise<SearchConfig> => {
  const stored = await getRepo().searchConfig.get()
  if (stored === null) return parseSearchConfigDefault()
  return parseSearchConfigStrict(stored)
}

export const saveSearchConfig = async (config: unknown): Promise<SearchConfig> => {
  const parsed = parseSearchConfigStrict(config)
  await getRepo().searchConfig.save(parsed)
  return parsed
}
