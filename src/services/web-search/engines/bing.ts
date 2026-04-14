import type { SearchEngine, SearchOptions } from "./interface"
import { filterByDomain } from "./interface"
import type { SearchResult } from "../types"

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"

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
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document",
        "Sec-Ch-Ua": '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
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

  private decodeHtmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  }

  private stripHtmlTags(text: string): string {
    return text.replace(/<[^>]+>/g, "")
  }

  private extractResult(block: string): SearchResult | null {
    // Extract URL and title from h2 > a
    const linkMatch = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!linkMatch) return null

    let url = this.decodeHtmlEntities(linkMatch[1] || "")
    const title = this.stripHtmlTags(linkMatch[2] || "").trim()

    if (!url || !title) return null

    // Decode Bing redirect URLs
    if (url.includes("bing.com/ck/a")) {
      const decoded = this.decodeRedirectUrl(url)
      if (!decoded) return null
      url = decoded
    }

    if (!url.startsWith("http")) return null

    // Extract snippet from p tag (try b_lineclamp first, then b_caption p)
    const snippetMatch =
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ||
      /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    const rawSnippet = (snippetMatch?.[1] || snippetMatch?.[2] || "").trim()
    const snippet = this.stripHtmlTags(this.decodeHtmlEntities(rawSnippet)) || "No description available"

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
