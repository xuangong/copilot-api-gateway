// vNext-native Copilot MCP web-search provider adapted into the reference
// `WebSearchProvider` abstraction (Spec 13-C-5, Q1c).
//
// Source engine: pre-refactor `orchestrator/server-tools/plugins/web-search/
// engines/copilot.ts` (restored from commit baf7ed9). Talks to GitHub's
// MCP server (`api.githubcopilot.com/mcp`) with the caller's GitHub OAuth
// token; GitHub holds the actual Bing/etc. credentials on their side. Uses
// JSON-RPC over streamable-http (may be plain JSON or SSE per response).
// No first-party fetch_page.

import { normalizeDomainList } from '../domain-normalize.ts'
import {
  type WebSearchFetchPageRequest,
  type WebSearchFetchPageResult,
  type WebSearchProvider,
  type WebSearchProviderRequest,
  type WebSearchProviderResult,
} from '../types.ts'
import { toWebSearchTextBlocks, validateWebSearchQuery } from './shared.ts'

const MCP_ENDPOINT = 'https://api.githubcopilot.com/mcp'
const SNIPPET_WINDOW = 240

interface JsonRpcEnvelope {
  result?: unknown
  error?: { code?: number; message?: string }
}

const parseJsonRpcEnvelope = (body: string): JsonRpcEnvelope | null => {
  const trimmed = body.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as JsonRpcEnvelope
    } catch {
      return null
    }
  }
  const dataLines: string[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  for (let i = dataLines.length - 1; i >= 0; i--) {
    const candidate = dataLines[i]
    if (!candidate) continue
    try {
      return JSON.parse(candidate) as JsonRpcEnvelope
    } catch {
      // try next
    }
  }
  return null
}

interface UrlCitation {
  title?: string
  url?: string
}

interface AnnotationItem {
  start_index?: number
  end_index?: number
  url_citation?: UrlCitation
}

interface InnerPayload {
  text?: { value?: string; annotations?: AnnotationItem[] }
}

interface CopilotResult {
  title: string
  url: string
  snippet: string
}

const sliceSnippet = (value: string, startIdx?: number, endIdx?: number): string => {
  if (!value) return ''
  const start = typeof startIdx === 'number' ? startIdx : 0
  const end = typeof endIdx === 'number' ? endIdx : start
  const windowStart = Math.max(0, start - SNIPPET_WINDOW)
  const windowEnd = Math.min(value.length, end + SNIPPET_WINDOW)
  return value
    .slice(windowStart, windowEnd)
    .replace(/【[^】]*】/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const extractResults = (result: unknown): CopilotResult[] => {
  if (!result || typeof result !== 'object') return []
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return []

  const results: CopilotResult[] = []
  const seen = new Set<string>()

  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const text = (item as { text?: unknown }).text
    if (typeof text !== 'string') continue

    let inner: InnerPayload
    try {
      inner = JSON.parse(text) as InnerPayload
    } catch {
      continue
    }
    const value = inner.text?.value ?? ''
    const annotations = inner.text?.annotations ?? []

    for (const ann of annotations) {
      const url = ann.url_citation?.url?.trim()
      if (!url || !url.startsWith('http')) continue
      if (seen.has(url)) continue
      seen.add(url)
      results.push({
        title: ann.url_citation?.title?.trim() || url,
        url,
        snippet: sliceSnippet(value, ann.start_index, ann.end_index) || 'No description available',
      })
    }
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

export const createCopilotWebSearchProvider = (githubToken: string, deps?: { fetch?: typeof fetch }): WebSearchProvider => {
  const httpFetch = deps?.fetch ?? fetch

  const search = async (request: WebSearchProviderRequest): Promise<WebSearchProviderResult> => {
    const validated = validateWebSearchQuery(request.query)
    if (validated.type === 'error') return validated.result

    try {
      const response = await httpFetch(MCP_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${githubToken}`,
          'X-MCP-Host': 'github-coding-agent',
          'X-MCP-Toolsets': 'web_search',
          'X-Initiator': 'agent',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'web_search', arguments: { query: validated.query } },
        }),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      })

      if (!response.ok) {
        let errorBody = ''
        try {
          errorBody = await response.text()
        } catch {
          // ignore
        }
        const snippet = errorBody ? ` body=${errorBody.slice(0, 500)}` : ''
        if (response.status === 429) {
          return { type: 'error', errorCode: 'too_many_requests', message: `Copilot MCP quota exceeded (HTTP 429)${snippet}` }
        }
        if (response.status === 401 || response.status === 403) {
          return { type: 'error', errorCode: 'unavailable', message: `Copilot MCP auth failed (HTTP ${response.status})${snippet}` }
        }
        return { type: 'error', errorCode: 'unavailable', message: `Copilot MCP failed (HTTP ${response.status})${snippet}` }
      }

      const bodyText = await response.text()
      const rpc = parseJsonRpcEnvelope(bodyText)
      if (!rpc) {
        return { type: 'error', errorCode: 'unavailable', message: 'Copilot MCP returned no parseable JSON-RPC payload.' }
      }
      if (rpc.error) {
        return { type: 'error', errorCode: 'unavailable', message: `Copilot MCP JSON-RPC error: ${rpc.error.message ?? 'unknown'}` }
      }

      const allowed = normalizeDomainList(request.allowedDomains)
      const blocked = normalizeDomainList(request.blockedDomains)
      const raw = extractResults(rpc.result).filter(r => matchesDomainFilter(r.url, allowed, blocked))

      return {
        type: 'ok',
        results: raw.map(r => ({
          source: r.url,
          title: r.title,
          content: toWebSearchTextBlocks(r.snippet),
        })),
      }
    } catch (error) {
      return {
        type: 'error',
        errorCode: 'unavailable',
        message: error instanceof Error ? error.message : 'Copilot MCP search failed.',
      }
    }
  }

  const fetchPage = async (_request: WebSearchFetchPageRequest): Promise<WebSearchFetchPageResult> => ({
    type: 'error',
    errorCode: 'unavailable',
    message: 'Copilot MCP provider does not support page fetch; configure a provider with fetch_page (tavily/jina).',
  })

  return { search, fetchPage }
}
