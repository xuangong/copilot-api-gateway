import type { SearchResult } from "./types"
import type { SearchEngine, SearchOptions } from "./engines"
import {
  BingSearchEngine,
  CopilotSearchEngine,
  LangSearchEngine,
  TavilySearchEngine,
  QuotaExceededError,
} from "./engines"

export interface EngineManagerOptions {
  langsearchKey?: string
  tavilyKey?: string
  bingEnabled?: boolean
  /** GitHub OAuth/PAT token used by Copilot MCP web_search (NOT the short-lived copilot session token). */
  githubToken?: string
  copilotEnabled?: boolean
  copilotPriority?: boolean
}

/**
 * Manages search engines with priority-based fallback.
 *
 * Default priority: LangSearch -> Tavily -> Bing -> Copilot (when enabled).
 * When `copilotPriority` is true, Copilot is the only engine used and there
 * is no fallback — failures bubble up as empty results.
 */
export class EngineManager {
  private engines: SearchEngine[] = []

  constructor(options: EngineManagerOptions) {
    const copilotAvailable = !!(options.copilotEnabled && options.githubToken)

    if (copilotAvailable && options.copilotPriority) {
      // Copilot-only mode: no fallback to other providers
      this.engines.push(new CopilotSearchEngine(options.githubToken!))
    } else {
      if (options.langsearchKey) {
        this.engines.push(new LangSearchEngine(options.langsearchKey))
      }

      if (options.tavilyKey) {
        this.engines.push(new TavilySearchEngine(options.tavilyKey))
      }

      // Bing is only added when explicitly enabled
      if (options.bingEnabled) {
        this.engines.push(new BingSearchEngine())
      }

      // Copilot as last-resort fallback when not given priority
      if (copilotAvailable) {
        this.engines.push(new CopilotSearchEngine(options.githubToken!))
      }
    }
  }

  /**
   * Search with automatic fallback to next engine on failure
   */
  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<{ results: SearchResult[]; engineName: string }> {
    for (const engine of this.engines) {
      try {
        const results = await engine.search(query, options)
        return { results, engineName: engine.name }
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          console.warn(
            `[EngineManager] ${engine.name} quota exceeded, trying next engine`,
          )
        } else {
          console.error(
            `[EngineManager] ${engine.name} failed: ${(error as Error).message}`,
          )
        }
        // Continue to next engine
      }
    }

    // All engines failed
    console.error("[EngineManager] All search engines failed")
    return { results: [], engineName: "none" }
  }
}
