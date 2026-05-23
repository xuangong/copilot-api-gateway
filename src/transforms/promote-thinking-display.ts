import type { AnthropicMessagesPayload } from "./types"

/**
 * Promote `thinking.display = "omitted"` to `"summarized"` for upstream so
 * the SSE stream gets continuous `thinking_delta` events — keeping bytes
 * flowing during long reasoning gaps that would otherwise hit the ~60s
 * first-byte / read-idle window in the client SDK or intermediate proxies.
 *
 * This is the request-side half of the workaround. The response-side half
 * (omitThinkingFromAnthropicSse, in src/lib/anthropic-sse-thinking-strip.ts)
 * removes thinking_delta text from the downstream stream so clients still
 * observe "omitted" semantics — only the final signature is preserved.
 *
 * Borrowed-in-spirit from Menci/copilot-gateway promote-thinking-display.ts.
 * Key differences:
 *   - We complement an existing protocol-level keepalive (event: ping in
 *     wrapAnthropicHeartbeat). That keepalive already prevents idle-byte
 *     starvation. Promoting thinking display is additionally useful when
 *     downstream clients implement their own "no data progress in N seconds"
 *     guard that's stricter than raw byte flow (some implementations count
 *     only "real" events, not pings).
 *   - We only act on Claude 4.6 / 4.5 family models. 4.7+ already defaults
 *     to streamed thinking (handled separately by adaptThinkingForModel).
 *
 * Streaming-only: this is meaningless for non-streaming JSON requests.
 * The upstream there buffers the entire response anyway — no amount of
 * `display` tweaking will make bytes flow earlier. Non-streaming gets
 * help from src/lib/heartbeat-json.ts instead.
 */

export interface PromoteThinkingDisplayResult {
  /** True if request was mutated; the response stream must strip thinking deltas. */
  promoted: boolean
  /** The display value originally requested by the client (for diagnostics). */
  originalDisplay?: "omitted" | "summarized" | "full"
}

/**
 * Mutates `payload.thinking.display` in place when applicable. Returns
 * `promoted: true` iff a mutation happened, so the caller can decide
 * whether to wrap the response in the matching SSE stripper.
 *
 * Skip conditions (any one → no-op):
 *   - Not a streaming request
 *   - No thinking config / thinking.type === "disabled"
 *   - Model is not in the Claude 4.6 / 4.5 family
 *   - Downstream-requested display is already "summarized" or "full"
 *     (only "omitted" or unspecified gets promoted)
 */
export function promoteThinkingDisplayForStreaming(
  payload: AnthropicMessagesPayload,
): PromoteThinkingDisplayResult {
  if (payload.stream !== true) return { promoted: false }
  if (!payload.thinking) return { promoted: false }
  if (!isClaude4_5_or_4_6(payload.model)) return { promoted: false }

  const originalDisplay = payload.thinking.display
  // Only "omitted" (or absent, which the upstream may default to omitted on
  // these models in some Copilot configurations) is worth promoting.
  if (originalDisplay === "summarized" || originalDisplay === "full") {
    return { promoted: false, originalDisplay }
  }

  payload.thinking = {
    ...payload.thinking,
    display: "summarized",
  }
  return { promoted: true, originalDisplay }
}

function isClaude4_5_or_4_6(model: string | undefined): boolean {
  if (!model) return false
  // Match "claude-sonnet-4-5", "claude-opus-4-6", dated variants,
  // and dotted aliases like "claude-4.5", "claude-4.6".
  return /claude(?:-[a-z]+)?-4[-.](?:5|6)/i.test(model)
}
