// Ported 1:1 from copilot-gateway data-plane/tools/web-search/operations.ts,
// with import path adaptations for vNext:
//   - truncatePreservingCodePoints → chat-flow (not chat) sub-tree
//   - isAbortError → local shared/abort.ts (vNext has no @floway-dev/provider package)
//   - protocol types → @vibe-llm/protocols/responses
//
// Shared parser, local-provider executor, and Responses web-search IR.
// Responses always uses the parser and IR; its local mode also executes and
// renders operations here, while alpha passthrough delegates the commands and
// retains the upstream model-facing output. The Codex compatibility route uses
// this engine only in its default local-provider mode.

import { normalizeDomainList } from './domain-normalize.ts'
import { fetchPageAndRecordUsage } from './fetch-page.ts'
import { searchWebAndRecordUsage } from './search.ts'
import type { ConfiguredWebSearchProvider, WebSearchProvider, WebSearchProviderName } from './types.ts'
import { truncatePreservingCodePoints } from '../../chat-flow/shared/text.ts'
import type { ResponsesWebSearchAction, ResponsesWebSearchResult } from '@vibe-llm/protocols/responses'
import { isAbortError } from '../../../shared/abort.ts'

// Search-context-size → result-count mapping. Approximates the ~40 results
// native hosted web_search returns regardless of search_context_size;
// backends bill per call, so larger result sets only multiply upstream
// context-window cost. `medium` is the native default (matches openai-python
// `WebSearchTool.search_context_size` docstring: "Defaults to 'medium'").
//   https://github.com/openai/openai-python/blob/f16fbbd2bd25dc1ff150b5f78dbd15ff6bab6d91/src/openai/types/responses/web_search_tool.py#L65-L70
export const CONTEXT_SIZE_TO_MAX_RESULTS: Record<'low' | 'medium' | 'high', number> = {
  low: 10,
  medium: 20,
  high: 40,
}

export const DEFAULT_SEARCH_CONTEXT_SIZE: keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS = 'medium'

const SEARCH_CONTEXT_SIZES = new Set<keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS>(['low', 'medium', 'high'])

export const isSearchContextSize = (v: unknown): v is keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS =>
  typeof v === 'string' && SEARCH_CONTEXT_SIZES.has(v as keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS)

// Default to native's documented default (`medium`) when omitted. Without
// this, a provider-side default (e.g. Tavily's smaller baseline count) would
// silently shrink the result set on requests that didn't set the field.
export const maxResultsForContextSize = (size: keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS | undefined): number =>
  CONTEXT_SIZE_TO_MAX_RESULTS[size ?? DEFAULT_SEARCH_CONTEXT_SIZE]

// Per-snippet char cap on a search result's rendered text. Providers like
// Tavily can return multi-KB snippets per hit; without this cap a single
// noisy query can blow the upstream context window. Independent of the
// provider-enforced 10 KiB cap on open_page bodies.
const MAX_SEARCH_SNIPPET_CHARS = 2_048

export interface WebSearchFilters {
  allowedDomains?: string[]
  blockedDomains?: string[]
  userLocation?: { city?: string; region?: string; country?: string; timezone?: string }
  maxResults?: number
}

// ── Command parsing ──
// One logical operation parsed out of a `{ search_query, open, find, … }`
// command object. The three implemented kinds (`search`, `open`, `find`)
// carry the backend inputs; every other populated key surfaces as an
// `unsupported` op, and a sub-property whose value isn't an array surfaces
// as `wrong-type`. `parseWebSearchOperations` produces a flat list in source
// order (search → open → find → the rest).

export type WebSearchOperationErrorKind = 'invalid-ref' | 'missing-arg'

export type WebSearchOperation =
  | {
    kind: 'search'
    arrayIndex: number
    query: string
    error?: string
    errorKind?: WebSearchOperationErrorKind
  }
  | {
    kind: 'open'
    arrayIndex: number
    error?: string
    errorKind?: WebSearchOperationErrorKind
    url: string
  }
  | {
    kind: 'find'
    arrayIndex: number
    error?: string
    errorKind?: WebSearchOperationErrorKind
    url: string
    pattern: string
  }
  | {
    kind: 'unsupported'
    subProperty: string
    arrayIndex: number
  }
  | {
    kind: 'wrong-type'
    subProperty: 'search_query' | 'open' | 'find'
    actualType: string
  }

export type ParsedWebSearchOperations = { kind: 'ops'; ops: WebSearchOperation[] } | { kind: 'malformed' }

// Stricter than `/^https?:\/\//i`: that regex accepts `https://` (empty
// host). Reject malformed refs at parse time so dispatch always sees a
// well-formed URL.
const isUrl = (s: string): boolean => {
  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.hostname === '') return false
  return true
}

const refIdError = (refId: string): string =>
  `Error: ref_id must be a fully-qualified URL in the gateway shim (got '${refId}'). The gateway shim does not preserve prior-call ids across turns.`

const missingArgError = (field: string): string =>
  `Error: missing required argument "${field}".`

const SUPPORTED_KEYS: ReadonlySet<string> = new Set(['search_query', 'open', 'find'])

const stringField = (entry: unknown, key: string): string => {
  if (entry === null || typeof entry !== 'object') return ''
  const value = (entry as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

const describeJsonType = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v

export const parseWebSearchOperations = (args: Record<string, unknown> | null): ParsedWebSearchOperations => {
  if (args === null) return { kind: 'malformed' }
  const ops: WebSearchOperation[] = []

  const searchQuery = args.search_query
  if (searchQuery !== undefined) {
    if (!Array.isArray(searchQuery)) {
      ops.push({ kind: 'wrong-type', subProperty: 'search_query', actualType: describeJsonType(searchQuery) })
    } else {
      for (let i = 0; i < searchQuery.length; i++) {
        const q = stringField(searchQuery[i], 'q')
        if (q === '') {
          ops.push({ kind: 'search', arrayIndex: i, query: '', error: missingArgError('q'), errorKind: 'missing-arg' })
          continue
        }
        ops.push({ kind: 'search', arrayIndex: i, query: q })
      }
    }
  }

  const open = args.open
  if (open !== undefined) {
    if (!Array.isArray(open)) {
      ops.push({ kind: 'wrong-type', subProperty: 'open', actualType: describeJsonType(open) })
    } else {
      for (let i = 0; i < open.length; i++) {
        const refId = stringField(open[i], 'ref_id')
        if (refId === '') {
          ops.push({ kind: 'open', arrayIndex: i, url: '', error: missingArgError('ref_id'), errorKind: 'missing-arg' })
          continue
        }
        if (!isUrl(refId)) {
          ops.push({ kind: 'open', arrayIndex: i, url: refId, error: refIdError(refId), errorKind: 'invalid-ref' })
          continue
        }
        ops.push({ kind: 'open', arrayIndex: i, url: refId })
      }
    }
  }

  const find = args.find
  if (find !== undefined) {
    if (!Array.isArray(find)) {
      ops.push({ kind: 'wrong-type', subProperty: 'find', actualType: describeJsonType(find) })
    } else {
      for (let i = 0; i < find.length; i++) {
        const refId = stringField(find[i], 'ref_id')
        const pattern = stringField(find[i], 'pattern')
        if (refId === '') {
          ops.push({ kind: 'find', arrayIndex: i, url: '', pattern, error: missingArgError('ref_id'), errorKind: 'missing-arg' })
          continue
        }
        if (!isUrl(refId)) {
          ops.push({ kind: 'find', arrayIndex: i, url: refId, pattern, error: refIdError(refId), errorKind: 'invalid-ref' })
          continue
        }
        if (pattern === '') {
          ops.push({ kind: 'find', arrayIndex: i, url: refId, pattern: '', error: missingArgError('pattern'), errorKind: 'missing-arg' })
          continue
        }
        ops.push({ kind: 'find', arrayIndex: i, url: refId, pattern })
      }
    }
  }

  for (const key of Object.keys(args)) {
    if (SUPPORTED_KEYS.has(key)) continue
    const value = args[key]
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        ops.push({ kind: 'unsupported', subProperty: key, arrayIndex: i })
      }
    } else {
      ops.push({ kind: 'unsupported', subProperty: key, arrayIndex: 0 })
    }
  }

  return { kind: 'ops', ops }
}

// ── Execution session ──

interface PageCacheEntry {
  content: string
  truncated: boolean
  fullContentBytes: number
  title?: string
}

export interface WebSearchExecutionSession {
  getProvider: () => Promise<ConfiguredWebSearchProvider>
  filters: WebSearchFilters
  apiKeyId: string
  pageCache: Map<string, PageCacheEntry>
  includeSearchActionSources: boolean
  signal?: AbortSignal
}

// ── IR construction ──

export interface WebSearchCallIR {
  action: ResponsesWebSearchAction
  results: ResponsesWebSearchResult[]
  outputText?: string
}

const searchIr = (
  query: string,
  results: ResponsesWebSearchResult[],
  sources?: { type: 'url'; url: string }[],
): WebSearchCallIR => searchIrFromQueries([query], results, sources)

const searchIrFromQueries = (
  queries: string[],
  results: ResponsesWebSearchResult[],
  sources?: { type: 'url'; url: string }[],
): WebSearchCallIR => ({
  action: {
    type: 'search',
    query: queries.join(' | '),
    queries,
    ...(sources !== undefined ? { sources } : {}),
  },
  results,
})

const openPageIr = (
  url: string | undefined,
  results: ResponsesWebSearchResult[],
): WebSearchCallIR => ({
  action: url !== undefined && url.length > 0
    ? { type: 'open_page', url }
    : { type: 'open_page' },
  results,
})

const findInPageIr = (
  url: string,
  pattern: string,
  results: ResponsesWebSearchResult[],
): WebSearchCallIR => ({
  action: { type: 'find_in_page', url, pattern },
  results,
})

export const schemaErrorIr = (
  queryLabel: string,
  title: string,
  snippet: string,
): WebSearchCallIR => ({
  action: { type: 'search', query: queryLabel, queries: [queryLabel] },
  results: [{ type: 'text_result', url: '', title, snippet }],
})

// ── Error / not-supported text ──
const searchFailedText = (providerMessage: string): string =>
  `Search failed: ${providerMessage}`

const openFailedText = (url: string, providerMessage: string): string =>
  `Error fetching URL \`${url}\`: ${providerMessage}`

const unsupportedOperationText = (subProperty: string): string =>
  `Error: the \`${subProperty}\` sub-property is not supported by this gateway. Only \`search_query\`, \`open\`, and \`find\` are available.`

const wrongTypeOperationText = (subProperty: string, actualType: string): string =>
  `Error: the \`${subProperty}\` sub-property must be an array of objects; got ${actualType}.`

const errorSnippet = (title: string, snippet: string): ResponsesWebSearchResult => ({
  type: 'text_result',
  url: '',
  title,
  snippet,
})

// ── Text rendering ──

export const actionSearchQueries = (action: Extract<ResponsesWebSearchAction, { type: 'search' }>): string[] => {
  if (action.queries !== undefined) return action.queries
  if (action.query !== undefined) return [action.query]
  return []
}

const formatSearchResultsText = (query: string, results: readonly ResponsesWebSearchResult[]): string => {
  const header = `Search results for "${query}":`
  if (results.length === 0) return `${header}\n\n(no results)`
  const sections = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
  return `${header}\n\n${sections.join('\n\n')}`
}

const renderOperationOutputText = (action: ResponsesWebSearchAction, results: ResponsesWebSearchResult[]): string => {
  switch (action.type) {
  case 'search': {
    const queryLabel = actionSearchQueries(action).join(' | ')
    return formatSearchResultsText(queryLabel, results)
  }
  case 'open_page': {
    if (results.length === 0) {
      const url = action.url ?? '(no url)'
      return `Open ${url}: (no body returned)`
    }
    return results[0]!.snippet
  }
  case 'find_in_page':
    return results.length > 0 ? results[0]!.snippet : ''
  }
}

export const renderWebSearchCallOutput = (ir: WebSearchCallIR): string =>
  ir.outputText ?? renderOperationOutputText(ir.action, ir.results)

// ── Domain filtering ──

const matchesAnyDomain = (hostname: string, domains: readonly string[]): boolean => {
  for (const d of domains) {
    if (hostname === d) return true
    if (hostname.endsWith(`.${d}`)) return true
  }
  return false
}

export const isUrlAllowed = (url: string, filter: WebSearchFilters): boolean => {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  const blocked = normalizeDomainList(filter.blockedDomains)
  if (blocked.length > 0 && matchesAnyDomain(hostname, blocked)) {
    return false
  }
  const allowed = normalizeDomainList(filter.allowedDomains)
  if (allowed.length > 0 && !matchesAnyDomain(hostname, allowed)) {
    return false
  }
  return true
}

// ── find (literal case-insensitive substring matcher) ──

interface FindMatch {
  before: string
  matched: string
  after: string
}

export const findMatches = (
  text: string,
  pattern: string,
  opts: { maxMatches: number; contextChars: number },
): FindMatch[] => {
  if (pattern.length === 0) return []
  const lowerText = text.toLowerCase()
  const lowerPat = pattern.toLowerCase()
  const matches: FindMatch[] = []
  let from = 0
  while (matches.length < opts.maxMatches) {
    const idx = lowerText.indexOf(lowerPat, from)
    if (idx < 0) break
    const beforeStart = Math.max(0, idx - opts.contextChars)
    const afterEnd = Math.min(text.length, idx + lowerPat.length + opts.contextChars)
    matches.push({
      before: text.slice(beforeStart, idx),
      matched: text.slice(idx, idx + lowerPat.length),
      after: text.slice(idx + lowerPat.length, afterEnd),
    })
    from = idx + lowerPat.length
  }
  return matches
}

export const formatMatches = (pattern: string, url: string, matches: readonly FindMatch[]): string => {
  if (matches.length === 0) return `No matching \`${pattern}\` found on ${url}.`
  const noun = matches.length === 1 ? 'match' : 'matches'
  const lines: string[] = [`${matches.length} ${noun} for pattern: \`${pattern}\``, '']
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!
    lines.push(`Match ${i + 1}:`)
    lines.push(`"...${m.before}[${m.matched}]${m.after}..."`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

const truncateString = (s: string, maxChars: number): string =>
  s.length <= maxChars ? s : `${truncatePreservingCodePoints(s, maxChars)}…`

// ── Provider resolution ──

const resolveActiveProvider = async (
  session: WebSearchExecutionSession,
): Promise<{ provider: WebSearchProvider; providerName: WebSearchProviderName } | { unavailable: string }> => {
  const configured = await session.getProvider()
  if (configured.type === 'enabled') {
    return { provider: configured.impl, providerName: configured.provider }
  }
  if (configured.type === 'disabled') {
    return { unavailable: 'Web search provider is not configured on this gateway.' }
  }
  return { unavailable: `Web search provider ${configured.provider} is missing its credential on this gateway.` }
}

// ── search ──

interface SearchQueryOutcome {
  results: ResponsesWebSearchResult[]
  sources?: { type: 'url'; url: string }[]
}

const runOneSearchQuery = async (
  query: string,
  session: WebSearchExecutionSession,
  active: { provider: WebSearchProvider; providerName: WebSearchProviderName },
): Promise<SearchQueryOutcome> => {
  try {
    const searchRequest = {
      query,
      maxResults: session.filters.maxResults,
      allowedDomains: session.filters.allowedDomains,
      blockedDomains: session.filters.blockedDomains,
      userLocation: session.filters.userLocation,
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
    }
    const result = await searchWebAndRecordUsage({
      provider: active.provider,
      providerName: active.providerName,
      keyId: session.apiKeyId,
      request: searchRequest,
    })

    if (result.type === 'error') {
      const msg = result.message ?? result.errorCode
      return { results: [errorSnippet('Search error', searchFailedText(msg))] }
    }

    const results: ResponsesWebSearchResult[] = result.results.map(r => ({
      type: 'text_result' as const,
      url: r.source,
      title: r.title,
      snippet: truncateString(r.content.map(c => c.text).join('\n'), MAX_SEARCH_SNIPPET_CHARS),
    }))
    const sources = session.includeSearchActionSources
      ? result.results.map(r => ({ type: 'url' as const, url: r.source }))
      : undefined
    return sources !== undefined ? { results, sources } : { results }
  } catch (e) {
    if (isAbortError(e)) throw e
    const msg = e instanceof Error ? e.message : String(e)
    return { results: [errorSnippet('Search error', searchFailedText(msg))] }
  }
}

const runBackendSearch = async (
  op: Extract<WebSearchOperation, { kind: 'search' }>,
  session: WebSearchExecutionSession,
): Promise<WebSearchCallIR> => {
  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id'
    return searchIr(op.query, [errorSnippet(title, op.error)])
  }
  const active = await resolveActiveProvider(session)
  if ('unavailable' in active) {
    return searchIr(op.query, [errorSnippet('Search error', searchFailedText(active.unavailable))])
  }
  const { results, sources } = await runOneSearchQuery(op.query, session, active)
  return searchIr(op.query, results, sources)
}

export const runBackendSearchMulti = async (
  ops: Array<Extract<WebSearchOperation, { kind: 'search' }>>,
  session: WebSearchExecutionSession,
): Promise<WebSearchCallIR> => {
  const queries = ops.map(op => op.query)
  const active = await resolveActiveProvider(session)
  if ('unavailable' in active) {
    return searchIrFromQueries(queries, [errorSnippet('Search error', searchFailedText(active.unavailable))])
  }
  const perQuery = await Promise.all(ops.map(op => runOneSearchQuery(op.query, session, active)))
  const mergedResults = perQuery.flatMap(r => r.results)
  const mergedSources = session.includeSearchActionSources
    ? perQuery.flatMap(r => r.sources ?? [])
    : undefined
  return searchIrFromQueries(queries, mergedResults, mergedSources)
}

// ── open / find (page fetch + cache) ──

type FetchAndCacheResult =
  | { ok: true; cached: PageCacheEntry }
  | { ok: false; output: string }

export type WebSearchPageFetchMap = Map<string, FetchAndCacheResult>

const runBatchFetch = async (
  needFetch: string[],
  session: WebSearchExecutionSession,
): Promise<WebSearchPageFetchMap> => {
  const perUrl: WebSearchPageFetchMap = new Map()
  const active = await resolveActiveProvider(session)
  if ('unavailable' in active) {
    for (const url of needFetch) {
      perUrl.set(url, { ok: false, output: openFailedText(url, active.unavailable) })
    }
    return perUrl
  }
  try {
    const fetchRequest = {
      urls: needFetch,
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
    }
    const result = await fetchPageAndRecordUsage({
      provider: active.provider,
      providerName: active.providerName,
      keyId: session.apiKeyId,
      request: fetchRequest,
    })

    if (result.type === 'error') {
      const msg = result.message ?? result.errorCode
      for (const url of needFetch) {
        perUrl.set(url, { ok: false, output: openFailedText(url, msg) })
      }
      return perUrl
    }

    const failureByUrl = new Map(result.failures.map(f => [f.url, f]))
    const pageByUrl = new Map(result.pages.map(p => [p.url, p]))
    for (const url of needFetch) {
      const failure = failureByUrl.get(url)
      if (failure) {
        perUrl.set(url, { ok: false, output: openFailedText(url, failure.message ?? failure.errorCode) })
        continue
      }
      const page = pageByUrl.get(url)
      if (!page) {
        perUrl.set(url, { ok: false, output: openFailedText(url, 'No page returned') })
        continue
      }
      const entry: PageCacheEntry = {
        content: page.content,
        truncated: page.truncated,
        fullContentBytes: page.fullContentBytes,
        title: page.title,
      }
      session.pageCache.set(url, entry)
      perUrl.set(url, { ok: true, cached: entry })
    }
    return perUrl
  } catch (e) {
    if (isAbortError(e)) throw e
    const msg = e instanceof Error ? e.message : String(e)
    for (const url of needFetch) {
      perUrl.set(url, { ok: false, output: openFailedText(url, msg) })
    }
    return perUrl
  }
}

const fetchAndCacheManyPages = async (
  urls: string[],
  session: WebSearchExecutionSession,
): Promise<WebSearchPageFetchMap> => {
  const results: WebSearchPageFetchMap = new Map()
  const needFetch: string[] = []
  const seen = new Set<string>()

  for (const url of urls) {
    if (seen.has(url)) continue
    seen.add(url)
    const cached = session.pageCache.get(url)
    if (cached) {
      results.set(url, { ok: true, cached })
      continue
    }
    needFetch.push(url)
  }

  if (needFetch.length > 0) {
    const perUrl = await runBatchFetch(needFetch, session)
    for (const url of needFetch) {
      results.set(url, perUrl.get(url)!)
    }
  }
  return results
}

export const startBatchFetch = async (
  parsed: ParsedWebSearchOperations,
  session: WebSearchExecutionSession,
): Promise<WebSearchPageFetchMap> => {
  if (parsed.kind !== 'ops') return new Map()
  const batchUrls: string[] = []
  const blockedUrls: string[] = []
  const seen = new Set<string>()
  for (const op of parsed.ops) {
    if (op.kind !== 'open' && op.kind !== 'find') continue
    if (op.error !== undefined) continue
    const url = op.url
    if (url === '') continue
    if (seen.has(url)) continue
    seen.add(url)
    if (!isUrlAllowed(url, session.filters)) {
      blockedUrls.push(url)
      continue
    }
    batchUrls.push(url)
  }
  const fetched = await fetchAndCacheManyPages(batchUrls, session)
  for (const url of blockedUrls) {
    fetched.set(url, { ok: false, output: openFailedText(url, 'Blocked by tool filters') })
  }
  return fetched
}

const openPageSuccessIr = (url: string, cached: PageCacheEntry): WebSearchCallIR => {
  const body = cached.content
    + (cached.truncated
      ? `\n\n[Content truncated; full page is ${cached.fullContentBytes} bytes. Use the \`find\` sub-property with a pattern to locate specific content.]`
      : '')
  return openPageIr(url, [{
    type: 'text_result',
    url,
    title: cached.title ?? '',
    snippet: body,
  }])
}

const runBackendOpenPage = async (
  op: Extract<WebSearchOperation, { kind: 'open' }>,
  batch: WebSearchPageFetchMap,
): Promise<WebSearchCallIR> => {
  const url = op.url

  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id'
    return searchIr(op.url, [errorSnippet(title, op.error)])
  }

  const fetched = batch.get(url)!
  if (!fetched.ok) {
    return openPageIr(url, [errorSnippet('Open page error', fetched.output)])
  }
  return openPageSuccessIr(url, fetched.cached)
}

const runBackendFind = async (
  op: Extract<WebSearchOperation, { kind: 'find' }>,
  batch: WebSearchPageFetchMap,
): Promise<WebSearchCallIR> => {
  const url = op.url
  const pattern = op.pattern

  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id'
    return findInPageIr(url, pattern, [errorSnippet(title, op.error)])
  }

  const fetched = batch.get(url)!
  if (!fetched.ok) {
    return findInPageIr(url, pattern, [errorSnippet('Find error', fetched.output)])
  }

  const matches = findMatches(fetched.cached.content, pattern, {
    maxMatches: 10,
    contextChars: 200,
  })
  const title = matches.length === 0 ? 'No match' : 'Matches'
  return findInPageIr(url, pattern, [{
    type: 'text_result',
    url,
    title,
    snippet: formatMatches(pattern, url, matches),
  }])
}

export const executeOperationToIr = (
  op: WebSearchOperation,
  session: WebSearchExecutionSession,
  batch: WebSearchPageFetchMap,
): Promise<WebSearchCallIR> => {
  switch (op.kind) {
  case 'search':
    return runBackendSearch(op, session)
  case 'open':
    return runBackendOpenPage(op, batch)
  case 'find':
    return runBackendFind(op, batch)
  case 'unsupported':
    return Promise.resolve(schemaErrorIr(
      `unsupported action: ${op.subProperty}[${op.arrayIndex}]`,
      'Unsupported action',
      unsupportedOperationText(op.subProperty),
    ))
  case 'wrong-type':
    return Promise.resolve(schemaErrorIr(
      `wrong-type sub-property: ${op.subProperty}`,
      'Malformed sub-property',
      wrongTypeOperationText(op.subProperty, op.actualType),
    ))
  }
}

export const executeOperationToText = async (
  op: WebSearchOperation,
  session: WebSearchExecutionSession,
  batch: WebSearchPageFetchMap,
): Promise<string> => {
  switch (op.kind) {
  case 'unsupported':
    return unsupportedOperationText(op.subProperty)
  case 'wrong-type':
    return wrongTypeOperationText(op.subProperty, op.actualType)
  default: {
    const ir = await executeOperationToIr(op, session, batch)
    return renderWebSearchCallOutput(ir)
  }
  }
}
