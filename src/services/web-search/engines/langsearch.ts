import type { SearchEngine, SearchOptions } from "./interface"
import { filterByDomain } from "./interface"
import type { SearchResult } from "../types"

interface LangSearchResponse {
  code: number
  msg: string | null
  data?: {
    webPages?: {
      value?: {
        name: string
        url: string
        snippet: string
        summary?: string | null
      }[]
    }
  }
}

const SEARCH_TIMEOUT_MS = 30_000

/**
 * LangSearch API implementation
 * Requires API key from environment variable
 */
export class LangSearchEngine implements SearchEngine {
  readonly name = "LangSearch"

  constructor(private readonly apiKey: string) {}

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    console.log(`[${this.name}] Searching: "${query}"`)

    const response = await fetch("https://api.langsearch.com/v1/web-search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query,
        summary: true,
        count: 10,
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      console.error(
        `[${this.name}] HTTP ${response.status} | body: ${body.slice(0, 200)}`,
      )
      throw new Error(`${this.name} returned status ${response.status}`)
    }

    const data = (await response.json()) as LangSearchResponse

    if (data.code !== 200) {
      throw new Error(
        `${this.name} API error: ${data.msg || `code ${data.code}`}`,
      )
    }

    const results = (data.data?.webPages?.value || [])
      .filter((item) => filterByDomain(item.url, options))
      .map((item) => ({
        title: item.name,
        url: item.url,
        snippet: item.summary || item.snippet || "No description available",
      }))

    console.log(`[${this.name}] Found ${results.length} results`)
    return results
  }
}
