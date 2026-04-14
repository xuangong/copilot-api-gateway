import type { SearchResult } from "./types"
import type { SearchEngine, SearchOptions } from "./engines"
import {
  BingSearchEngine,
  LangSearchEngine,
  TavilySearchEngine,
  QuotaExceededError,
} from "./engines"

export interface EngineManagerOptions {
  langsearchKey?: string
  tavilyKey?: string
  bingEnabled?: boolean
}

/**
 * Manages search engines with priority-based fallback
 * Priority: LangSearch -> Tavily -> Bing
 */
export class EngineManager {
  private engines: SearchEngine[] = []

  constructor(options: EngineManagerOptions) {
    // Initialize engines based on available API keys
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

    console.log(
      `[EngineManager] Initialized with engines: ${this.engines.map((e) => e.name).join(", ")}`,
    )
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
