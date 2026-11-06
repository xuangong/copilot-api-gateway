import { estimateMessagesInputTokens } from "./token-estimate"

// Claude Code's gateway contract: a 400/413 whose whole `error.message` is this
// token triggers the same recovery as Anthropic's "prompt is too long" wording
// (auto-compact, then trimming the oldest turns until the summary request fits).
const PROMPT_TOO_LONG_REJECTION = "capability_rejected: prompt_too_long"
// Loki's own prompt data protection scan rejects text above a fixed size before
// the model sees it. In Claude Code sessions that limit sits just under 1M tokens.
const DLP_CONTENT_TOO_LARGE = "prompt_dlp_content_too_large"
// Loki replaces every Anthropic 400 with this code and "Upstream rejected the
// request.", including "prompt is too long: N tokens > M maximum", so an
// overflow can only be inferred from the request itself.
const GENERIC_REJECTION = "invalid_body"
// The estimate undercounts dense text by up to ~20% and binary media more, so
// a generic rejection at 70% of the window is treated as an overflow. A wrong
// guess costs one compaction of an already large conversation; a missed one
// strands the session.
const OVERFLOW_ESTIMATE_RATIO = 0.7
const MAX_ERROR_BODY_BYTES = 65_536

function rejectionCode(bytes: Uint8Array): { code: string; type: unknown } | undefined {
  try {
    const error = (JSON.parse(new TextDecoder().decode(bytes)) as { error?: { code?: unknown; type?: unknown } }).error
    return typeof error?.code === "string" ? { code: error.code, type: error.type } : undefined
  } catch {
    return undefined
  }
}

/**
 * Re-labels the Loki rejections that hide a context overflow so Claude Code
 * compacts instead of stranding the session. Every other response, including
 * an Anthropic-worded rejection, is returned with its original bytes.
 */
export async function lokiMessagesRejection(response: Response, payload: Record<string, unknown>,
  contextWindow: number | undefined): Promise<Response> {
  if (response.status !== 400 && response.status !== 413) return response
  if (Number(response.headers.get("content-length")) > MAX_ERROR_BODY_BYTES) return response
  const bytes = new Uint8Array(await response.arrayBuffer())
  const original = new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
  const rejection = rejectionCode(bytes)
  const dlp = response.status === 413 && rejection?.code === DLP_CONTENT_TOO_LARGE
  const generic = response.status === 400 && rejection?.code === GENERIC_REJECTION
  if (!rejection || (!dlp && !generic)) return original

  // Logged for both outcomes so production can confirm where the threshold sits.
  const estimatedTokens = contextWindow === undefined ? undefined : estimateMessagesInputTokens(payload)
  const relabel = dlp || (estimatedTokens !== undefined && contextWindow !== undefined
    && estimatedTokens >= contextWindow * OVERFLOW_ESTIMATE_RATIO)
  console.warn("[loki.rejection_classified]", JSON.stringify({ status: response.status, code: rejection.code,
    estimatedTokens: estimatedTokens ?? null, contextWindow: contextWindow ?? null, relabelled: relabel }))
  if (!relabel) return original

  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify({ type: "error", error: {
    type: typeof rejection.type === "string" ? rejection.type : "invalid_request_error",
    code: rejection.code, message: PROMPT_TOO_LONG_REJECTION,
  } }), { status: response.status, headers })
}
