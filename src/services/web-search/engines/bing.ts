import type { SearchEngine, SearchOptions } from "./interface"
import { filterByDomain } from "./interface"
import type { SearchResult } from "../types"

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/**
 * Bing search engine implementation using HTML parsing
 * Works in Cloudflare Workers (no cheerio, uses regex parsing)
 */
export class BingSearchEngine implements SearchEngine {
  readonly name = "Bing"

  private readonly baseUrl = "https://www.bing.com/search"

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    console.log(`[${this.name}] Searching: "${query}"`)

    const html = await this.fetchSearchPage(query)
    const results = this.parseResults(html, options)

    console.log(`[${this.name}] Found ${results.length} results`)
    return results
  }

  private async fetchSearchPage(query: string): Promise<string> {
    const url = new URL(this.baseUrl)
    url.searchParams.set("q", query)
    url.searchParams.set("setlang", "en")
    url.searchParams.set("cc", "US")

    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
    })

    if (!response.ok) {
      throw new Error(`${this.name} returned status ${response.status}`)
    }

    return response.text()
  }

  private parseResults(
    html: string,
    options?: SearchOptions,
  ): SearchResult[] {
    const results: SearchResult[] = []

    // Parse using regex (CF Workers compatible)
    // Match li.b_algo blocks
    const algoPattern = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
    let match

    while ((match = algoPattern.exec(html)) !== null && results.length < 10) {
      const block = match[1]
      if (!block) continue

      const result = this.extractResult(block)
      if (!result) continue

      if (filterByDomain(result.url, options)) {
        results.push(result)
      }
    }

    return results
  }

  private extractResult(block: string): SearchResult | null {
    // Extract URL and title from h2 > a
    const linkMatch = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i.exec(block)
    if (!linkMatch) return null

    let url = linkMatch[1] || ""
    const title = (linkMatch[2] || "").trim()

    if (!url || !title) return null

    // Decode Bing redirect URLs
    if (url.includes("bing.com/ck/a")) {
      const decoded = this.decodeRedirectUrl(url)
      if (!decoded) return null
      url = decoded
    }

    if (!url.startsWith("http")) return null

    // Extract snippet from p tag
    const snippetMatch = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([^<]+)<\/p>/i.exec(block)
    const snippet = snippetMatch?.[1]?.trim() || "No description available"

    return { title, url, snippet }
  }

  private decodeRedirectUrl(redirectUrl: string): string | null {
    try {
      const urlObj = new URL(redirectUrl)
      const encodedUrl = urlObj.searchParams.get("u")
      if (!encodedUrl) return null

      const base64Url = encodedUrl.startsWith("a1")
        ? encodedUrl.substring(2)
        : encodedUrl

      return atob(base64Url)
    } catch (error) {
      console.warn(`[${this.name}] Failed to decode URL: ${error}`)
      return null
    }
  }
}
