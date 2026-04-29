import type { SearchEngine, SearchOptions } from "./interface"
import { filterByDomain, QuotaExceededError } from "./interface"
import type { SearchResult } from "../types"

const SEARCH_TIMEOUT_MS = 30_000
const MCP_ENDPOINT = "https://api.githubcopilot.com/mcp"
const SNIPPET_WINDOW = 240

/**
 * GitHub Copilot web search via the github-mcp-server `web_search` tool.
 *
 * Uses the same authentication as the gateway's upstream Copilot calls:
 * the user's GitHub OAuth/PAT token (NOT a classic ghp_ token). All
 * search-provider keys (Bing, etc.) are held by GitHub's MCP server side;
 * the client only sends `{query}`.
 *
 * The MCP endpoint speaks streamable-http: the response Content-Type is
 * `text/event-stream` and carries a single JSON-RPC frame in `data:` lines.
 */
export class CopilotSearchEngine implements SearchEngine {
  readonly name = "Copilot"

  constructor(private readonly githubToken: string) {}

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    console.log(`[${this.name}] Searching: "${query}"`)

    const response = await fetch(MCP_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.githubToken}`,
        "X-MCP-Host": "github-coding-agent",
        "X-MCP-Toolsets": "web_search",
        "X-Initiator": "agent",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search",
          arguments: { query },
        },
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      // Capture body for diagnostics — MCP error messages live in the body,
      // not the status code. Without this we cannot tell why a 400 happened.
      let errorBody = ""
      try {
        errorBody = await response.text()
      } catch {
        // ignore
      }
      const bodySnippet = errorBody ? ` body=${errorBody.slice(0, 500)}` : ""

      if (response.status === 429) {
        throw new QuotaExceededError(
          this.name,
          `Copilot MCP quota exceeded (HTTP 429)${bodySnippet}`,
        )
      }
      if (response.status === 401 || response.status === 403) {
        throw new QuotaExceededError(
          this.name,
          `Copilot MCP auth failed (HTTP ${response.status})${bodySnippet}`,
        )
      }
      throw new Error(`${this.name} returned status ${response.status}${bodySnippet}`)
    }

    const bodyText = await response.text()
    const rpcEnvelope = parseJsonRpcEnvelope(bodyText)
    if (!rpcEnvelope) {
      throw new Error(`${this.name} returned no parseable JSON-RPC payload`)
    }
    if (rpcEnvelope.error) {
      throw new Error(
        `${this.name} JSON-RPC error: ${rpcEnvelope.error.message ?? "unknown"}`,
      )
    }

    const results = extractResults(rpcEnvelope.result).filter((r) =>
      filterByDomain(r.url, options),
    )

    console.log(`[${this.name}] Found ${results.length} results`)
    return results
  }
}

interface JsonRpcEnvelope {
  result?: unknown
  error?: { code?: number; message?: string }
}

/**
 * Parse a JSON-RPC envelope from either a plain JSON body or an SSE stream.
 * MCP streamable-http puts the full JSON-RPC frame after a `data: ` line.
 */
function parseJsonRpcEnvelope(body: string): JsonRpcEnvelope | null {
  const trimmed = body.trim()
  if (!trimmed) return null

  // Plain JSON body
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as JsonRpcEnvelope
    } catch {
      return null
    }
  }

  // SSE: collect every `data:` line, prefer the last frame that parses
  const dataLines: string[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim())
    }
  }
  for (let i = dataLines.length - 1; i >= 0; i--) {
    const candidate = dataLines[i]
    if (!candidate) continue
    try {
      return JSON.parse(candidate) as JsonRpcEnvelope
    } catch {
      // try next
    }
  }
  return null
}

interface UrlCitation {
  title?: string
  url?: string
}

interface AnnotationItem {
  text?: string
  start_index?: number
  end_index?: number
  url_citation?: UrlCitation
}

interface InnerPayload {
  type?: string
  text?: {
    value?: string
    annotations?: AnnotationItem[]
  }
}

/**
 * The MCP `result` for web_search looks like:
 *   { content: [ { type: "text", text: "<stringified inner JSON>" } ] }
 *
 * The inner JSON is `{ type: "output_text", text: { value, annotations[] } }`
 * where each annotation has `url_citation.{title,url}` and `start_index`/
 * `end_index` pointing into `text.value`. We turn each citation into a
 * SearchResult and slice a window around the cited offsets as the snippet.
 */
function extractResults(result: unknown): SearchResult[] {
  if (!result || typeof result !== "object") return []
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return []

  const results: SearchResult[] = []
  const seen = new Set<string>()

  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const text = (item as { text?: unknown }).text
    if (typeof text !== "string") continue

    let inner: InnerPayload
    try {
      inner = JSON.parse(text) as InnerPayload
    } catch {
      continue
    }

    const value = inner.text?.value ?? ""
    const annotations = inner.text?.annotations ?? []

    for (const ann of annotations) {
      const citation = ann.url_citation
      const url = citation?.url?.trim()
      if (!url || !url.startsWith("http")) continue
      if (seen.has(url)) continue
      seen.add(url)

      const title = citation?.title?.trim() || url
      const snippet = sliceSnippet(value, ann.start_index, ann.end_index)

      results.push({
        title,
        url,
        snippet: snippet || "No description available",
      })
    }
  }

  return results
}

function sliceSnippet(
  value: string,
  startIdx?: number,
  endIdx?: number,
): string {
  if (!value) return ""
  const start = typeof startIdx === "number" ? startIdx : 0
  const end = typeof endIdx === "number" ? endIdx : start
  const windowStart = Math.max(0, start - SNIPPET_WINDOW)
  const windowEnd = Math.min(value.length, end + SNIPPET_WINDOW)
  return value
    .slice(windowStart, windowEnd)
    .replace(/【[^】]*】/g, "")
    .replace(/\s+/g, " ")
    .trim()
}
