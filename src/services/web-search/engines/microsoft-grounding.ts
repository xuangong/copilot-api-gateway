import type { SearchEngine, SearchOptions } from "./interface"
import { filterByDomain, QuotaExceededError } from "./interface"
import type { SearchResult } from "../types"

const SEARCH_TIMEOUT_MS = 30_000
const ENDPOINT = "https://api.microsoft.ai/v3/search/web"
const DEFAULT_RESULT_COUNT = 10
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/i

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const normalizeDomains = (domains?: string[]): string[] =>
  domains?.map((d) => d.trim()).filter((d) => DOMAIN_PATTERN.test(d)) ?? []

interface MicrosoftWebResult {
  title?: string
  url?: string
  content?: unknown
  lastUpdatedAt?: string
  crawledAt?: string
}

interface MicrosoftPassage {
  text?: string
}

const passageToSnippet = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const entry of content) {
      if (typeof entry === "string") {
        parts.push(entry)
      } else if (entry && typeof entry === "object") {
        const text = (entry as MicrosoftPassage).text
        if (typeof text === "string") parts.push(text)
      }
    }
    return parts.join(" ").trim()
  }
  return ""
}

/**
 * Microsoft Grounding (api.microsoft.ai) web search.
 *
 * Authenticated via `x-apikey`. Domain allow/block is best-effort via
 * `site:` / `-site:` query operators (the API has no dedicated fields).
 * 429s are retried at this boundary with fixed 1s/2s/4s/8s backoff;
 * upstream `retryAfter` is intentionally ignored.
 */
export class MicrosoftGroundingEngine implements SearchEngine {
  readonly name = "MicrosoftGrounding"

  constructor(private readonly apiKey: string) {}

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    console.log(`[${this.name}] Searching: "${query}"`)

    const queryParts = [
      query,
      ...normalizeDomains(options?.allowedDomains).map((d) => `site:${d}`),
      ...normalizeDomains(options?.blockedDomains).map((d) => `-site:${d}`),
    ]
    const body = {
      query: queryParts.join(" "),
      count: DEFAULT_RESULT_COUNT,
      contentFormat: "passage",
    }

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-apikey": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      })

      if (response.ok) {
        const payload = (await response.json()) as {
          webResults?: MicrosoftWebResult[]
        }
        const raw = Array.isArray(payload?.webResults) ? payload.webResults : []
        const results: SearchResult[] = []
        for (const item of raw) {
          if (typeof item?.title !== "string" || typeof item?.url !== "string") {
            continue
          }
          if (!filterByDomain(item.url, options)) continue
          const snippet = passageToSnippet(item.content)
          results.push({
            title: item.title,
            url: item.url,
            snippet: snippet || "No description available",
          })
          if (results.length >= DEFAULT_RESULT_COUNT) break
        }
        console.log(`[${this.name}] Found ${results.length} results`)
        return results
      }

      if (response.status === 429) {
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]!)
          continue
        }
        throw new QuotaExceededError(
          this.name,
          `Microsoft Grounding rate limited (HTTP 429)`,
        )
      }

      if (response.status === 401 || response.status === 403) {
        throw new QuotaExceededError(
          this.name,
          `Microsoft Grounding auth failed (HTTP ${response.status})`,
        )
      }

      throw new Error(`${this.name} returned status ${response.status}`)
    }

    throw new Error("unreachable")
  }
}
