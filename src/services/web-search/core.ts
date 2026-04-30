import { getApiKeyById } from "~/lib/api-keys"
import { getRepo } from "~/repo"

import { EngineManager, type EngineManagerOptions } from "./engine-manager"
import { resolveWebSearchKeys } from "./resolver"
import { formatSearchResults } from "./formatter"
import type { WebSearchMeta, WebSearchTool } from "./types"

export const MAX_USES_HARD_LIMIT = 4

export const emptyMeta = (): WebSearchMeta => ({
  searchCount: 0,
  totalResults: 0,
  enginesUsed: [],
  successes: 0,
  failures: 0,
})

export interface SearchExecutionResult {
  content: string
  isError: boolean
  resultCount: number
  engineName: string
}

/**
 * Execute one web search call against the configured engine chain and
 * record success/failure into `meta`. Pure side-effect on `meta`; returns
 * the formatted text payload to inject back into the model.
 */
export async function executeWebSearch(
  query: string,
  webSearchTool: Pick<WebSearchTool, "allowed_domains" | "blocked_domains"> | null,
  engineManager: EngineManager,
  meta: WebSearchMeta,
): Promise<SearchExecutionResult> {
  const searchOptions = {
    allowedDomains: webSearchTool?.allowed_domains,
    blockedDomains: webSearchTool?.blocked_domains,
  }

  try {
    const { results, engineName } = await engineManager.search(query, searchOptions)
    const resultCount = results.length
    meta.totalResults += resultCount
    meta.successes++
    if (engineName !== "none" && !meta.enginesUsed.includes(engineName)) {
      meta.enginesUsed.push(engineName)
    }
    return {
      content: formatSearchResults(results),
      isError: false,
      resultCount,
      engineName,
    }
  } catch (error) {
    meta.failures++
    console.error("[Web Search] Search failed:", error)
    return {
      content: `Error: Search failed - ${(error as Error).message}`,
      isError: true,
      resultCount: 0,
      engineName: "none",
    }
  }
}

export interface WebSearchConfigResult {
  enabled: boolean
  engineOptions?: EngineManagerOptions
  /** Pre-built 400 response when web search is requested but the key is not authorised. */
  errorResponse?: Response
}

/**
 * Resolve a key's web-search config to an EngineManagerOptions block, or
 * a ready-to-return 400 Response if the key is not allowed to web-search.
 */
export async function loadWebSearchConfig(
  apiKeyId: string | undefined,
  githubToken: string,
  envMsGroundingKey?: string,
): Promise<WebSearchConfigResult> {
  const keyConfig = apiKeyId ? await getApiKeyById(apiKeyId) : null
  if (!keyConfig?.webSearchEnabled) {
    return {
      enabled: false,
      errorResponse: new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message:
              "Web search is not enabled for this API key. Configure it in the dashboard.",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    }
  }

  const resolved = await resolveWebSearchKeys(keyConfig, envMsGroundingKey)

  return {
    enabled: true,
    engineOptions: {
      langsearchKey: resolved.langsearchKey,
      tavilyKey: resolved.tavilyKey,
      githubToken,
      msGroundingKey: resolved.msGroundingKey,
      priority: keyConfig.webSearchPriority,
    },
  }
}

export function addWebSearchHeaders(
  headers: Record<string, string>,
  meta: WebSearchMeta,
): void {
  if (meta.searchCount > 0) {
    headers["X-Web-Search-Count"] = String(meta.searchCount)
    headers["X-Web-Search-Results"] = String(meta.totalResults)
    headers["X-Web-Search-Engines"] = meta.enginesUsed.join(",")
  }
}

/**
 * Best-effort record of per-key/per-hour web-search counts. Errors swallowed —
 * the search itself already succeeded; failed bookkeeping shouldn't fail the request.
 */
export function recordWebSearchUsage(
  apiKeyId: string | undefined,
  meta: WebSearchMeta,
): void {
  if (!apiKeyId || meta.searchCount === 0) return
  const hour = new Date().toISOString().slice(0, 13)
  const repo = getRepo()
  for (let i = 0; i < meta.successes; i++) {
    repo.webSearchUsage.record(apiKeyId, hour, true).catch(() => {})
  }
  for (let i = 0; i < meta.failures; i++) {
    repo.webSearchUsage.record(apiKeyId, hour, false).catch(() => {})
  }
}
