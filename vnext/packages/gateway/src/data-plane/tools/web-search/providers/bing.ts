// vNext-native Bing HTML scrape provider adapted into the reference
// `WebSearchProvider` abstraction (Spec 13-C-5, Q1c).
//
// Source engine: pre-refactor `orchestrator/server-tools/plugins/web-search/
// engines/bing.ts` (restored from commit baf7ed9). Bing has no first-party
// search API so this scrapes the public SERP HTML with a browser UA. Every
// call is one upstream request; no `fetchPage` support (returns `unavailable`).

import { normalizeDomainList } from '../domain-normalize.ts'
import {
  DEFAULT_WEB_SEARCH_RESULT_COUNT,
  type WebSearchFetchPageRequest,
  type WebSearchFetchPageResult,
  type WebSearchProvider,
  type WebSearchProviderRequest,
  type WebSearchProviderResult,
} from '../types.ts'
import { toWebSearchTextBlocks, validateWebSearchQuery } from './shared.ts'

const BING_URL = 'https://www.bing.com/search'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'

const decodeHtmlEntities = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

const stripHtmlTags = (text: string): string => text.replace(/<[^>]+>/g, '')

const decodeBingRedirect = (redirectUrl: string): string | null => {
  try {
    const urlObj = new URL(redirectUrl)
    const encodedUrl = urlObj.searchParams.get('u')
    if (!encodedUrl) return null
    const base64Url = encodedUrl.startsWith('a1') ? encodedUrl.substring(2) : encodedUrl
    return atob(base64Url)
  } catch {
    return null
  }
}

interface BingResult {
  title: string
  url: string
  snippet: string
}

const extractResult = (block: string): BingResult | null => {
  const linkMatch = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
  if (!linkMatch) return null

  let url = decodeHtmlEntities(linkMatch[1] || '')
  const title = stripHtmlTags(linkMatch[2] || '').trim()
  if (!url || !title) return null

  if (url.includes('bing.com/ck/a')) {
    const decoded = decodeBingRedirect(url)
    if (!decoded) return null
    url = decoded
  }
  if (!url.startsWith('http')) return null

  const snippetMatch =
    /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ||
    /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
  const rawSnippet = (snippetMatch?.[1] || snippetMatch?.[2] || '').trim()
  const snippet = stripHtmlTags(decodeHtmlEntities(rawSnippet)) || 'No description available'

  return { title, url, snippet }
}

const parseResults = (html: string): BingResult[] => {
  const results: BingResult[] = []
  const algoPattern = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  let match: RegExpExecArray | null
  while ((match = algoPattern.exec(html)) !== null && results.length < 20) {
    const block = match[1]
    if (!block) continue
    const result = extractResult(block)
    if (result) results.push(result)
  }
  return results
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

export const createBingWebSearchProvider = (_apiKey: string, deps?: { fetch?: typeof fetch }): WebSearchProvider => {
  const httpFetch = deps?.fetch ?? fetch

  const search = async (request: WebSearchProviderRequest): Promise<WebSearchProviderResult> => {
    const validated = validateWebSearchQuery(request.query)
    if (validated.type === 'error') return validated.result

    const url = new URL(BING_URL)
    url.searchParams.set('q', validated.query)
    url.searchParams.set('setlang', 'en')
    url.searchParams.set('cc', 'US')

    try {
      const response = await httpFetch(url.toString(), {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'en-US,en;q=0.9',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        },
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      })

      if (!response.ok) {
        if (response.status === 429) {
          return { type: 'error', errorCode: 'too_many_requests', message: 'Bing rate limited the request.' }
        }
        return { type: 'error', errorCode: 'unavailable', message: `Bing returned HTTP ${response.status}.` }
      }

      const html = await response.text()
      const allowed = normalizeDomainList(request.allowedDomains)
      const blocked = normalizeDomainList(request.blockedDomains)
      const limit = request.maxResults ?? DEFAULT_WEB_SEARCH_RESULT_COUNT
      const raw = parseResults(html).filter(r => matchesDomainFilter(r.url, allowed, blocked))

      return {
        type: 'ok',
        results: raw.slice(0, limit).map(r => ({
          source: r.url,
          title: r.title,
          content: toWebSearchTextBlocks(r.snippet),
        })),
      }
    } catch (error) {
      return {
        type: 'error',
        errorCode: 'unavailable',
        message: error instanceof Error ? error.message : 'Bing search failed.',
      }
    }
  }

  // Bing has no first-party page extract API; the shim's open-page step
  // must go through a provider that supports it.
  const fetchPage = async (_request: WebSearchFetchPageRequest): Promise<WebSearchFetchPageResult> => ({
    type: 'error',
    errorCode: 'unavailable',
    message: 'Bing provider does not support page fetch; configure a provider with fetch_page (tavily/jina).',
  })

  return { search, fetchPage }
}
