import type { AppState } from "~/lib/state"
import type { WebSearchMeta } from "~/services/web-search"
import type { AnthropicMessagesPayload } from "~/transforms"

export interface RouteContext {
  state: AppState
  body: AnthropicMessagesPayload
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
  request: Request
}

// Timeout for non-streaming requests (5 minutes)
export const SYNC_REQUEST_TIMEOUT_MS = 5 * 60 * 1000

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
 * Forward client-supplied anthropic-beta and anthropic-version headers so
 * upstream sees opt-ins (computer-use, extended-thinking, prompt-caching
 * variants) and the negotiated API version.
 *
 * Beta filtering (allowlist) happens inside CopilotProvider so every endpoint
 * benefits — including chat-completions / responses / count_tokens — without
 * each route having to know about it.
 */
export function extractAnthropicPassthroughHeaders(
  ctx: unknown,
): Record<string, string> {
  const reqHeaders = (ctx as { request: Request }).request.headers
  const out: Record<string, string> = {}
  const beta = reqHeaders.get("anthropic-beta") ?? reqHeaders.get("Anthropic-Beta")
  if (beta) out["anthropic-beta"] = beta
  const version = reqHeaders.get("anthropic-version") ?? reqHeaders.get("Anthropic-Version")
  if (version) out["anthropic-version"] = version
  return out
}

/**
 * Best-effort diag log for Office-family clients (the ones that suffer
 * first-byte timeouts). Standard Claude Code requests get nothing.
 */
export function logOfficeClientEntry(
  ctx: unknown,
  body: AnthropicMessagesPayload,
  requestId: string | undefined,
  userAgent: string | undefined,
  elapsed: () => number,
): void {
  const ua = userAgent ?? ""
  const isOffice = /Office|PowerPoint|PPT|Word|Excel|Outlook|claude-powerpoint|claude-word|claude-excel/i.test(ua)
  if (!isOffice) return
  try {
    const tools = Array.isArray((body as unknown as { tools?: unknown[] }).tools)
      ? (body as unknown as { tools: unknown[] }).tools
      : []
    console.log(JSON.stringify({
      evt: "msg_in",
      rid: requestId,
      model: body.model,
      stream: body.stream === true,
      msgs: Array.isArray(body.messages) ? body.messages.length : 0,
      toolCount: tools.length,
      max_tokens: (body as { max_tokens?: number }).max_tokens,
      ua: ua.slice(0, 60),
    }))
    const sig = (ctx as { request: Request }).request.signal
    if (sig) {
      sig.addEventListener("abort", () => {
        console.log(JSON.stringify({ evt: "client_abort", rid: requestId, elapsedMs: elapsed() }))
      })
    }
  } catch { /* best-effort */ }
}
