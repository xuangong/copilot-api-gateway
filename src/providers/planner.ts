/**
 * Target-preference planner.
 *
 * Given a client-facing source endpoint and a binding's native upstream
 * endpoints, pick the best upstream endpoint to dispatch to. Native is
 * always preferred; fallbacks follow per-source preference order based
 * on translation faithfulness:
 *
 *   - Messages source:        messages → responses → chat_completions
 *   - Responses source:       responses → messages → chat_completions
 *   - Chat-completions src:   chat_completions → messages → responses
 *   - Gemini source:          chat_completions → messages → responses
 *
 * Returning `null` means no binding endpoint can serve this source.
 */

import type { ModelEndpoint } from "~/protocols/common"

/** Source protocol the client is speaking. */
export type SourceProtocol = "messages" | "responses" | "chat_completions" | "gemini"

/** Selected target the dispatcher should call. */
export type TargetEndpoint =
  | "messages"
  | "responses"
  | "chat_completions"

const PREFERENCE: Record<SourceProtocol, readonly TargetEndpoint[]> = {
  messages: ["messages", "responses", "chat_completions"],
  responses: ["responses", "messages", "chat_completions"],
  chat_completions: ["chat_completions", "messages", "responses"],
  // Gemini has no native translator to Responses; prefer chat-completions,
  // then messages, then responses last (longest translation chain).
  gemini: ["chat_completions", "messages", "responses"],
}

/**
 * Pick the highest-preference target endpoint the binding natively serves.
 * Returns null when none of the binding's endpoints can be used for this source.
 */
export function pickTarget(
  source: SourceProtocol,
  upstreamEndpoints: readonly ModelEndpoint[],
): TargetEndpoint | null {
  for (const candidate of PREFERENCE[source]) {
    if (upstreamEndpoints.includes(candidate)) return candidate
  }
  return null
}

/**
 * Return the binding's effective target preference for this source —
 * useful for telemetry / dashboard rendering of "would dispatch via X".
 */
export function preferenceOrder(source: SourceProtocol): readonly TargetEndpoint[] {
  return PREFERENCE[source]
}
