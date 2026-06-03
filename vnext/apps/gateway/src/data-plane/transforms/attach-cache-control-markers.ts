/**
 * Attach Copilot's private `copilot_cache_control: { type: "ephemeral" }`
 * marker on selected Chat Completions messages so Copilot will prompt-cache
 * the stable prefixes (system) and the recent tail (last user turn + its
 * trailing tool results).
 *
 * Selection rules (mirrors copilot-gateway/Floway):
 *   - First N eligible `system` messages from the start (N = 2).
 *   - Last N eligible non-`system` messages from the end (N = 2).
 *   - "Eligible" means content is a non-empty string or non-empty array.
 *   - Indexes are merged, deduped, and applied in original order.
 *
 * The marker is a Copilot-private extension — generic OpenAI servers ignore
 * it, so it's safe to send unconditionally on this endpoint.
 *
 * Adapted from copilot-gateway/Floway:
 * apps/api/src/data-plane/providers/copilot/interceptors/chat-completions/attach-cache-control-markers.ts
 */

const COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT = 2
const COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT = 2

interface ChatMessage {
  role?: string
  content?: unknown
}

function isEligible(message: ChatMessage): boolean {
  const { content } = message
  if (typeof content === "string") return content.length > 0
  return Array.isArray(content) && content.length > 0
}

function selectCacheMarkerIndexes(messages: readonly ChatMessage[]): number[] {
  const systemIndexes: number[] = []
  for (
    let i = 0;
    i < messages.length && systemIndexes.length < COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT;
    i++
  ) {
    const m = messages[i]
    if (m?.role === "system" && isEligible(m)) systemIndexes.push(i)
  }

  const nonSystemIndexes: number[] = []
  for (
    let i = messages.length - 1;
    i >= 0 && nonSystemIndexes.length < COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT;
    i--
  ) {
    const m = messages[i]
    if (m && m.role !== "system" && isEligible(m)) nonSystemIndexes.push(i)
  }

  return [...new Set([...systemIndexes, ...nonSystemIndexes])].sort((a, b) => a - b)
}

export function attachCacheControlMarkers(payload: {
  messages?: ChatMessage[]
}): number {
  if (!Array.isArray(payload.messages)) return 0
  const indexes = selectCacheMarkerIndexes(payload.messages)
  for (const i of indexes) {
    (payload.messages[i] as ChatMessage & {
      copilot_cache_control?: { type: "ephemeral" }
    }).copilot_cache_control = { type: "ephemeral" }
  }
  return indexes.length
}
