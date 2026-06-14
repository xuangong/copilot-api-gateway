import type { SearchEngine, SearchOptions } from "./interface"
import { filterByDomain, QuotaExceededError } from "./interface"
import type { SearchResult } from "../types"

interface TavilySearchResponse {
  results?: {
    title: string
    url: string
    content: string
  }[]
}

const SEARCH_TIMEOUT_MS = 30_000

/**
 * Tavily API implementation
 * Requires API key from environment variable
 */
export class TavilySearchEngine implements SearchEngine {
  readonly id = "tavily" as const
  readonly name = "Tavily"

  constructor(private readonly apiKey: string) {}

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    console.log(`[${this.name}] Searching: "${query}"`)

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      if (response.status === 432 || response.status === 433) {
        throw new QuotaExceededError(
          this.name,
          `Tavily quota exceeded (HTTP ${response.status})`,
        )
      }
      throw new Error(`${this.name} returned status ${response.status}`)
    }

    const data = (await response.json()) as TavilySearchResponse

    const results = (data.results || [])
      .filter((item) => filterByDomain(item.url, options))
      .map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content || "No description available",
      }))

    console.log(`[${this.name}] Found ${results.length} results`)
    return results
  }
}
