import type {
  AnthropicMessagesPayload,
  AnthropicThinkingBlock,
} from "./types"

const THINKING_PLACEHOLDER = "Thinking..."

/**
 * Filter invalid thinking blocks from assistant turns.
 * Invalid: empty `thinking` text or the literal "Thinking..." placeholder
 * (some clients emit a placeholder for streaming UX).
 *
 * Ported from `src/transforms/thinking-cleanup.ts` in the legacy gateway.
 */
export function filterThinkingBlocks(payload: AnthropicMessagesPayload): void {
  for (const msg of payload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block) => {
        if (block.type !== "thinking") return true
        const tb = block as AnthropicThinkingBlock
        if (!tb.thinking || tb.thinking === THINKING_PLACEHOLDER) return false
        return true
      })
    }
  }
}

/**
 * What the upstream catalog says this model can do, distilled to the two facts
 * the thinking contract turns on. Derived from `capabilities.supports` on
 * Copilot's `/models` — see `thinkingCapabilitiesFor` in ../variants.
 */
export interface ThinkingCapabilities {
  /** `supports.adaptive_thinking === true` */
  adaptiveThinking: boolean
  /** `supports.reasoning_effort` present and non-empty */
  reasoningEffort: boolean
}

/**
 * Normalize thinking + reasoning-effort fields per upstream model contract.
 *
 * - A model with no `reasoning_effort` (today: Claude Haiku 4.5) rejects
 *   `output_config` entirely ("model does not support reasoning effort") and
 *   only accepts `thinking.type: "enabled"`. Strip `output_config` and
 *   downgrade `adaptive` → `enabled` with a safe budget.
 *
 * - A model advertising `adaptive_thinking` rejects `thinking.type: "enabled"`
 *   and requires `"adaptive"` plus `output_config.effort`. Convert if the
 *   client still uses the older shape.
 *
 * This used to match on the model id with a regex, on the reasoning that the
 * raw_models cache was out of scope here. That regex enumerated versions
 * (4.7/4.8) and families (opus|sonnet|haiku), so it silently missed every
 * `claude-*-5` — a 400 on the first Claude 5 request — and would have missed
 * `claude-fable-5` besides. The capability metadata is authoritative and needs
 * no edit when Anthropic ships a version or a family we've never heard of, so
 * the caller now resolves it and passes it in.
 *
 * `caps === undefined` means we could not read the catalog for this upstream.
 * That is deliberately a no-op rather than a guess: an unreadable catalog
 * leaves the request exactly as the client sent it.
 */
export function adaptThinkingForModel(
  payload: AnthropicMessagesPayload,
  caps: ThinkingCapabilities | undefined,
): void {
  if (!payload.model) return
  if (!caps) return

  if (!caps.reasoningEffort) {
    if (payload.output_config) {
      delete payload.output_config
    }
    if (payload.thinking?.type === "adaptive") {
      payload.thinking.type = "enabled"
      if (!payload.thinking.budget_tokens) {
        payload.thinking.budget_tokens = 1024
      }
    }
    return
  }

  if (!payload.thinking) return

  if (!caps.adaptiveThinking) return

  if (payload.thinking.type === "enabled") {
    payload.thinking.type = "adaptive"
    delete payload.thinking.budget_tokens
    if (!payload.output_config) {
      payload.output_config = { effort: "medium" }
    }
  }
}
