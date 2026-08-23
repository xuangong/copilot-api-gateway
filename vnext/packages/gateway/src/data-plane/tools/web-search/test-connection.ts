/**
 * "Does this key's web search actually work?" for the dashboard.
 *
 * Without it the only way to find out is to send a real chat request and read
 * the answer for signs a search happened — which is exactly how a whole
 * environment ran for weeks with no engine configured. The reference project
 * has the same button for its global config (`POST /search-config/test`); this
 * is the per-key equivalent.
 */

import type { ApiKey } from '../../../repo/types.ts'
import { providerNameFor, type KeyWebSearchResolution } from './key-config.ts'
import type { SearchConfigConnectionTestResult, WebSearchPreviewResult } from './types.ts'

/**
 * Fixed so repeated tests are comparable and cheap to cache upstream. Dull on
 * purpose: nothing about the query should influence whether it succeeds.
 */
export const TEST_QUERY = 'what is the capital of France'

/** Enough to see the engine is answering, few enough not to fill the panel. */
const PREVIEW_LIMIT = 5
const PREVIEW_TEXT_LIMIT = 280

const failure = (
  provider: SearchConfigConnectionTestResult['provider'],
  code: string,
  message: string,
): SearchConfigConnectionTestResult => ({ ok: false, provider, query: TEST_QUERY, error: { code, message } })

export const testKeyWebSearch = async (
  key: ApiKey,
  resolve: (key: ApiKey) => Promise<KeyWebSearchResolution>,
): Promise<SearchConfigConnectionTestResult> => {
  const resolved = await resolve(key)

  // The two "not working" states are fixed in different places, so the button
  // has to tell them apart: one is a switch, the other is a missing credential.
  if (resolved.type === 'disabled') {
    return failure('bing', 'disabled', 'Web search is turned off for this key.')
  }
  if (resolved.type === 'none') {
    return failure('bing', 'no_engine', 'No engine on this key has a usable credential.')
  }

  const provider = providerNameFor(resolved.engines[0]!)
  let result
  try {
    result = await resolved.impl.search({ query: TEST_QUERY, maxResults: PREVIEW_LIMIT })
  } catch (err) {
    return failure(provider, 'threw', err instanceof Error ? err.message : String(err))
  }

  if (result.type === 'error') {
    return failure(provider, result.errorCode, result.message ?? 'The search failed.')
  }
  // An engine that answers with nothing is configured but useless. The
  // fallback chain already treats empty as a soft failure; so does the button.
  if (result.results.length === 0) {
    return failure(provider, 'empty', 'The engine answered, but returned no results.')
  }

  const results: WebSearchPreviewResult[] = result.results.slice(0, PREVIEW_LIMIT).map((r) => ({
    title: r.title,
    url: r.source,
    ...(r.pageAge !== undefined ? { pageAge: r.pageAge } : {}),
    previewText: r.content.map((c) => c.text).join('\n').slice(0, PREVIEW_TEXT_LIMIT),
  }))
  return { ok: true, provider, query: TEST_QUERY, results }
}
