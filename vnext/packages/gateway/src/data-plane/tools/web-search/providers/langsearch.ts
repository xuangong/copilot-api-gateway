// vNext-native LangSearch provider adapted into the reference
// `WebSearchProvider` abstraction (Spec 13-C-5, Q1c).
//
// Source engine: pre-refactor `orchestrator/server-tools/plugins/web-search/
// engines/langsearch.ts` (restored from commit baf7ed9). LangSearch offers
// `POST /v1/web-search`; no first-party page extract endpoint, so
// `fetchPage` returns `unavailable`.

import { normalizeDomainList } from '../domain-normalize.ts'
import {
  DEFAULT_WEB_SEARCH_RESULT_COUNT,
  type WebSearchFetchPageRequest,
  type WebSearchFetchPageResult,
  type WebSearchProvider,
  type WebSearchProviderRequest,
  type WebSearchProviderResult,
} from '../types.ts'
import { extractWebSearchProviderErrorMessage, isJsonObject, toWebSearchTextBlocks, validateWebSearchQuery } from './shared.ts'

const LANGSEARCH_URL = 'https://api.langsearch.com/v1/web-search'

interface LangSearchWebPage {
  name?: string
  url?: string
  snippet?: string
  summary?: string | null
}

const matchesDomainFilter = (url: string, allowed: string[], blocked: string[]): boolean => {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  const matchesAny = (list: string[]): boolean => list.some(dom => hostname === dom || hostname.endsWith(`.${dom}`))
  if (allowed.length > 0 && !matchesAny(allowed)) return false
  if (blocked.length > 0 && matchesAny(blocked)) return false
  return true
}

export const createLangSearchWebSearchProvider = (apiKey: string, deps?: { fetch?: typeof fetch }): WebSearchProvider => {
  const httpFetch = deps?.fetch ?? fetch

  const search = async (request: WebSearchProviderRequest): Promise<WebSearchProviderResult> => {
    const validated = validateWebSearchQuery(request.query)
    if (validated.type === 'error') return validated.result

    const limit = request.maxResults ?? DEFAULT_WEB_SEARCH_RESULT_COUNT

    try {
      const response = await httpFetch(LANGSEARCH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: validated.query,
          summary: true,
          count: Math.max(1, limit),
        }),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      })

      if (!response.ok) {
        const message = await extractWebSearchProviderErrorMessage(response)
        if (response.status === 429) {
          return { type: 'error', errorCode: 'too_many_requests', message: message ?? 'LangSearch rate limited the request.' }
        }
        if (response.status === 401 || response.status === 403) {
          return { type: 'error', errorCode: 'unavailable', message: message ?? `LangSearch auth failed (HTTP ${response.status}).` }
        }
        return { type: 'error', errorCode: 'unavailable', message: message ?? `LangSearch failed (HTTP ${response.status}).` }
      }

      const payload = await response.json()
      if (!isJsonObject(payload)) {
        return { type: 'error', errorCode: 'unavailable', message: 'LangSearch returned an unexpected payload shape.' }
      }
      if (payload.code !== 200) {
        return {
          type: 'error',
          errorCode: 'unavailable',
          message: typeof payload.msg === 'string' && payload.msg.length > 0 ? payload.msg : `LangSearch code ${String(payload.code)}`,
        }
      }
      const data = isJsonObject(payload.data) ? payload.data : {}
      const webPages = isJsonObject(data.webPages) ? data.webPages : {}
      const value = Array.isArray(webPages.value) ? (webPages.value as LangSearchWebPage[]) : []

      const allowed = normalizeDomainList(request.allowedDomains)
      const blocked = normalizeDomainList(request.blockedDomains)

      const results = value
        .filter(item => typeof item.url === 'string' && matchesDomainFilter(item.url, allowed, blocked))
        .slice(0, limit)
        .map(item => ({
          source: item.url as string,
          title: item.name ?? item.url ?? '',
          content: toWebSearchTextBlocks(item.summary ?? item.snippet ?? ''),
        }))

      return { type: 'ok', results }
    } catch (error) {
      return {
        type: 'error',
        errorCode: 'unavailable',
        message: error instanceof Error ? error.message : 'LangSearch failed.',
      }
    }
  }

  const fetchPage = async (_request: WebSearchFetchPageRequest): Promise<WebSearchFetchPageResult> => ({
    type: 'error',
    errorCode: 'unavailable',
    message: 'LangSearch provider does not support page fetch; configure a provider with fetch_page (tavily/jina).',
  })

  return { search, fetchPage }
}
