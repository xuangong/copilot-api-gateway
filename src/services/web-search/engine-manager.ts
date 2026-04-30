import type { SearchResult } from "./types"
import type { SearchEngine, SearchOptions } from "./engines"
import {
  BingSearchEngine,
  CopilotSearchEngine,
  LangSearchEngine,
  MicrosoftGroundingEngine,
  TavilySearchEngine,
  QuotaExceededError,
} from "./engines"

/** Canonical engine ids used in priority lists. */
export type EngineId = "msGrounding" | "langsearch" | "tavily" | "bing" | "copilot"

export const ENGINE_IDS: readonly EngineId[] = [
  "msGrounding",
  "langsearch",
  "tavily",
  "bing",
  "copilot",
] as const

export interface EngineManagerOptions {
  langsearchKey?: string
  tavilyKey?: string
  bingEnabled?: boolean
  /** GitHub OAuth/PAT token used by Copilot MCP web_search (NOT the short-lived copilot session token). */
  githubToken?: string
  copilotEnabled?: boolean
  copilotPriority?: boolean
  /** Microsoft Grounding (api.microsoft.ai) key. */
  msGroundingKey?: string
  /**
   * Per-key engine priority. If provided, overrides legacy resolution: the
   * manager walks this list in order and only includes engines whose
   * prerequisites are satisfied (key present / githubToken / etc.). Unknown
   * ids and unconfigured engines are silently skipped.
   *
   * If undefined/empty, falls back to the legacy chain:
   *   msGrounding (if key) -> copilotPriority exclusive (if set)
   *                        -> langsearch -> tavily -> bing -> copilot.
   */
  priority?: string[]
}

const isEngineId = (v: string): v is EngineId =>
  (ENGINE_IDS as readonly string[]).includes(v)

/**
 * Manages search engines with priority-based fallback. See `priority` doc on
 * `EngineManagerOptions` for resolution semantics.
 */
export class EngineManager {
  private engines: SearchEngine[] = []

  constructor(options: EngineManagerOptions) {
    if (options.priority && options.priority.length > 0) {
      const seen = new Set<EngineId>()
      for (const raw of options.priority) {
        if (typeof raw !== "string") continue
        if (!isEngineId(raw)) continue
        if (seen.has(raw)) continue
        seen.add(raw)
        const engine = this.tryBuild(raw, options)
        if (engine) this.engines.push(engine)
      }
      return
    }

    // Legacy resolution (preserves prior behavior).
    if (options.msGroundingKey) {
      this.engines.push(new MicrosoftGroundingEngine(options.msGroundingKey))
      return
    }

    const copilotAvailable = !!(options.copilotEnabled && options.githubToken)
    if (copilotAvailable && options.copilotPriority) {
      this.engines.push(new CopilotSearchEngine(options.githubToken!))
      return
    }

    if (options.langsearchKey) {
      this.engines.push(new LangSearchEngine(options.langsearchKey))
    }
    if (options.tavilyKey) {
      this.engines.push(new TavilySearchEngine(options.tavilyKey))
    }
    if (options.bingEnabled) {
      this.engines.push(new BingSearchEngine())
    }
    if (copilotAvailable) {
      this.engines.push(new CopilotSearchEngine(options.githubToken!))
    }
  }

  private tryBuild(id: EngineId, opts: EngineManagerOptions): SearchEngine | null {
    switch (id) {
      case "msGrounding":
        return opts.msGroundingKey ? new MicrosoftGroundingEngine(opts.msGroundingKey) : null
      case "langsearch":
        return opts.langsearchKey ? new LangSearchEngine(opts.langsearchKey) : null
      case "tavily":
        return opts.tavilyKey ? new TavilySearchEngine(opts.tavilyKey) : null
      case "bing":
        // Bing has no key. Treat presence in the priority list as opt-in,
        // ignoring the legacy `bingEnabled` flag.
        return new BingSearchEngine()
      case "copilot":
        return opts.copilotEnabled && opts.githubToken
          ? new CopilotSearchEngine(opts.githubToken)
          : null
    }
  }

  /** Search with automatic fallback to the next engine on failure. */
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
      }
    }
    console.error("[EngineManager] All search engines failed")
    return { results: [], engineName: "none" }
  }
}
