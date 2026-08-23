/**
 * Per-key web-search engine resolution.
 *
 * The three chat shims used to read one global `search_config` row that had no
 * UI and no API route — the only way to set it was editing the database by
 * hand, so every environment but the hand-edited one answered "requires an
 * enabled search provider". Meanwhile the Keys tab already let you configure
 * engines per API key, and nothing in the data plane read any of it.
 *
 * This module closes that gap: it turns an API key's own configuration into a
 * `WebSearchProvider`, walking the key's priority list and falling through the
 * engines whose credentials actually resolved.
 *
 * Semantics are ported from the pre-vNext gateway
 * (`src/services/web-search/resolver.ts`, `engine-manager.ts`), which is what
 * the dashboard's panel was written against.
 */

import type { ApiKey } from '../../../repo/types.ts'
import { createBingWebSearchProvider } from './providers/bing.ts'
import { createCopilotWebSearchProvider } from './providers/copilot.ts'
import { createJinaWebSearchProvider } from './providers/jina.ts'
import { createLangSearchWebSearchProvider } from './providers/langsearch.ts'
import { createMicrosoftGroundingWebSearchProvider } from './providers/microsoft-grounding.ts'
import { createTavilyWebSearchProvider } from './providers/tavily.ts'
import type {
  WebSearchProviderName,
  WebSearchFetchPageRequest,
  WebSearchFetchPageResult,
  WebSearchProvider,
  WebSearchProviderRequest,
  WebSearchProviderResult,
} from './types.ts'

/** Engine ids as the dashboard's priority list spells them. */
export const ENGINE_IDS = ['msGrounding', 'langsearch', 'tavily', 'jina', 'bing', 'copilot'] as const

export type EngineId = (typeof ENGINE_IDS)[number]

/**
 * Order used when a key expresses no preference. Credentialed engines first,
 * then the two that need no key of their own — bing scrapes a public SERP,
 * copilot borrows a GitHub token from an upstream — so a key with the switch
 * on but nothing filled in still searches instead of silently doing nothing.
 */
export const DEFAULT_ENGINE_ORDER: readonly EngineId[] = ENGINE_IDS

const isEngineId = (v: unknown): v is EngineId =>
  typeof v === 'string' && (ENGINE_IDS as readonly string[]).includes(v)

/**
 * The key's priority list, cleaned: unknown ids dropped, duplicates collapsed,
 * and an empty result treated as "no preference expressed" rather than "no
 * engines" — a typo in the list should not silently disable search.
 */
export const orderedEngines = (priority: readonly unknown[] | undefined): EngineId[] => {
  const cleaned: EngineId[] = []
  const seen = new Set<EngineId>()
  for (const raw of priority ?? []) {
    if (!isEngineId(raw) || seen.has(raw)) continue
    seen.add(raw)
    cleaned.push(raw)
  }
  return cleaned.length > 0 ? cleaned : [...DEFAULT_ENGINE_ORDER]
}

/**
 * The dashboard's priority list and the usage table spell one engine
 * differently — `msGrounding` there, `microsoft-grounding` here. Translate at
 * the boundary so usage rows keep the canonical provider vocabulary instead of
 * splitting one engine's stats across two spellings.
 */
export const providerNameFor = (id: EngineId): WebSearchProviderName =>
  id === 'msGrounding' ? 'microsoft-grounding' : id

/** Credentials the engines need, after literals and borrows are resolved. */
export interface KeyCredentials {
  msGrounding?: string
  langsearch?: string
  tavily?: string
  jina?: string
  /** Not stored on the key — borrowed from a Copilot upstream by the caller. */
  copilot?: string
}

/** Looks up another key by id; null when it doesn't exist. */
export type KeyLookup = (id: string) => Promise<ApiKey | null>
/** Whether the borrower may read the source key's credentials. */
export type VisibilityCheck = (source: ApiKey, borrowerOwnerId: string | undefined) => Promise<boolean>

const alwaysVisible: VisibilityCheck = async () => true

/**
 * Resolves each credentialed engine to a literal.
 *
 * A key either holds the credential itself or points at another key with
 * `*_ref`. Borrowing is one level deep on purpose: following the source's own
 * ref would let a chain of keys expose a credential its owner never shared
 * with the borrower. A source that can't be seen — or a lookup that fails —
 * resolves to nothing rather than raising, so one bad reference can't take the
 * other engines down with it.
 */
export const resolveKeyCredentials = async (
  key: ApiKey,
  lookup: KeyLookup,
  isVisible: VisibilityCheck = alwaysVisible,
): Promise<KeyCredentials> => {
  const one = async (
    literal: string | undefined,
    refId: string | undefined,
    pick: (source: ApiKey) => string | undefined,
  ): Promise<string | undefined> => {
    if (literal) return literal
    if (!refId) return undefined
    const source = await lookup(refId).catch(() => null)
    if (!source) return undefined
    if (!(await isVisible(source, key.ownerId).catch(() => false))) return undefined
    return pick(source) || undefined
  }

  const [msGrounding, langsearch, tavily, jina] = await Promise.all([
    one(key.webSearchMsGroundingKey, key.webSearchMsGroundingRef, (s) => s.webSearchMsGroundingKey),
    one(key.webSearchLangsearchKey, key.webSearchLangsearchRef, (s) => s.webSearchLangsearchKey),
    one(key.webSearchTavilyKey, key.webSearchTavilyRef, (s) => s.webSearchTavilyKey),
    one(key.webSearchJinaKey, key.webSearchJinaRef, (s) => s.webSearchJinaKey),
  ])

  const out: KeyCredentials = {}
  if (msGrounding) out.msGrounding = msGrounding
  if (langsearch) out.langsearch = langsearch
  if (tavily) out.tavily = tavily
  if (jina) out.jina = jina
  return out
}

/**
 * Builds one engine, or null when its prerequisite is missing. Bing is the
 * exception with no credential at all: appearing in the priority list is the
 * whole opt-in, so the provider takes a sentinel.
 */
export const buildEngine = (id: EngineId, creds: KeyCredentials): WebSearchProvider | null => {
  switch (id) {
    case 'msGrounding':
      return creds.msGrounding ? createMicrosoftGroundingWebSearchProvider(creds.msGrounding) : null
    case 'langsearch':
      return creds.langsearch ? createLangSearchWebSearchProvider(creds.langsearch) : null
    case 'tavily':
      return creds.tavily ? createTavilyWebSearchProvider(creds.tavily) : null
    case 'jina':
      return creds.jina ? createJinaWebSearchProvider(creds.jina) : null
    case 'bing':
      return createBingWebSearchProvider('bing-public-scrape')
    case 'copilot':
      return creds.copilot ? createCopilotWebSearchProvider(creds.copilot) : null
  }
}

interface Engine {
  id: EngineId
  impl: WebSearchProvider
}

const failure = (message: string): { type: 'error'; errorCode: 'unavailable'; message: string } => ({
  type: 'error',
  errorCode: 'unavailable',
  message,
})

const NO_ENGINE = 'no web search engine is configured for this API key'

/**
 * Tries each engine in order, advancing on a thrown error, a provider-level
 * error, or an empty result set. Empty carries no information for the caller,
 * so it counts as a soft failure — the rule the pre-vNext engine manager used.
 * Whatever the last engine actually said is returned when they all fall
 * through, so the caller sees a real outcome rather than a synthetic one.
 */
export const createFallbackWebSearchProvider = (engines: readonly Engine[]): WebSearchProvider => ({
  async search(request: WebSearchProviderRequest): Promise<WebSearchProviderResult> {
    let last: WebSearchProviderResult = failure(NO_ENGINE)
    for (const engine of engines) {
      try {
        const result = await engine.impl.search(request)
        last = result
        if (result.type === 'ok' && result.results.length > 0) return result
      } catch (err) {
        last = failure(`${engine.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return last
  },

  async fetchPage(request: WebSearchFetchPageRequest): Promise<WebSearchFetchPageResult> {
    let last: WebSearchFetchPageResult = failure(NO_ENGINE)
    for (const engine of engines) {
      try {
        const result = await engine.impl.fetchPage(request)
        last = result
        if (result.type === 'ok' && result.pages.length > 0) return result
      } catch (err) {
        last = failure(`${engine.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return last
  },
})

export type KeyWebSearchResolution =
  /** The key has web search switched off. */
  | { type: 'disabled' }
  /** Switched on, but not one engine has what it needs to run. */
  | { type: 'none' }
  | { type: 'enabled'; engines: EngineId[]; impl: WebSearchProvider }

/**
 * Resolves an API key to the provider its shims should use.
 *
 * `disabled` and `none` are ordinary outcomes, not errors. The shim drops the
 * hosted tool and lets the model answer without search; failing the request
 * would turn a configuration gap into a 500 the caller can do nothing about
 * mid-conversation.
 */
export const resolveKeyWebSearch = async (
  key: ApiKey,
  lookup: KeyLookup,
  copilotToken: () => Promise<string | undefined>,
  isVisible: VisibilityCheck = alwaysVisible,
): Promise<KeyWebSearchResolution> => {
  if (!key.webSearchEnabled) return { type: 'disabled' }

  const order = orderedEngines(key.webSearchPriority)
  const creds = await resolveKeyCredentials(key, lookup, isVisible)
  // Only pay for the upstream lookup when copilot is actually in the running.
  if (order.includes('copilot')) {
    const token = await copilotToken().catch(() => undefined)
    if (token) creds.copilot = token
  }

  const engines: Engine[] = []
  for (const id of order) {
    const impl = buildEngine(id, creds)
    if (impl) engines.push({ id, impl })
  }
  if (engines.length === 0) return { type: 'none' }

  return {
    type: 'enabled',
    engines: engines.map((e) => e.id),
    impl: engines.length === 1 ? engines[0]!.impl : createFallbackWebSearchProvider(engines),
  }
}

/** The subset of an upstream record this module reads. */
interface CopilotTokenSource {
  provider: string
  enabled: boolean
  sortOrder: number
  config: Record<string, unknown>
}

/**
 * Picks the GitHub token the copilot engine searches with.
 *
 * That engine calls GitHub's MCP endpoint on the caller's behalf, and an API
 * key has nowhere to store a GitHub token — so it borrows one from a Copilot
 * upstream, which already holds exactly this credential. Selection is by
 * `sortOrder` so the choice is deterministic when several are configured, and
 * an upstream with a blank token is skipped rather than short-circuiting the
 * search.
 */
export const pickCopilotSearchToken = (
  upstreams: readonly CopilotTokenSource[],
): string | undefined => {
  const candidates = upstreams
    .filter((u) => u.provider === 'copilot' && u.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder)
  for (const candidate of candidates) {
    const token = candidate.config?.githubToken
    if (typeof token === 'string' && token.length > 0) return token
  }
  return undefined
}
