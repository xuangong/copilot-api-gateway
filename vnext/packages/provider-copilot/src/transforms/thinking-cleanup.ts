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
 * Normalize thinking + reasoning-effort fields per upstream model contract.
 *
 * - Claude Haiku 4.5 (and dated variants) rejects `output_config` entirely
 *   ("model does not support reasoning effort") and only accepts
 *   `thinking.type: "enabled"`. Strip `output_config` and downgrade
 *   `adaptive` → `enabled` with a safe budget.
 *
 * - Claude 4.7+ (Opus/Sonnet/Haiku 4.7, Opus 4.8, future 4.x≥7) rejects
 *   `thinking.type: "enabled"` and requires `thinking.type: "adaptive"` plus
 *   `output_config.effort`. Convert if the client still uses the older shape.
 *
 * Why duplicate the model-matching logic instead of reading capability
 * metadata: this interceptor runs without the Copilot raw_models cache in
 * scope (the variant-filter interceptor owns that closure). A regex over the
 * Anthropic naming convention is good enough — Anthropic versions are sparse
 * and additive.
 *
 * Ported from `src/transforms/thinking-cleanup.ts` (legacy gateway) and
 * extended to cover 4.8 (legacy only matched 4.7).
 */
export function adaptThinkingForModel(payload: AnthropicMessagesPayload): void {
  if (!payload.model) return

  if (modelRejectsReasoningEffort(payload.model)) {
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

  if (!modelRequiresAdaptiveThinking(payload.model)) return

  if (payload.thinking.type === "enabled") {
    payload.thinking.type = "adaptive"
    delete payload.thinking.budget_tokens
    if (!payload.output_config) {
      payload.output_config = { effort: "medium" }
    }
  }
}

/**
 * Models that reject `output_config` outright. Currently only Haiku 4.5
 * variants; extend as new restricted slots appear.
 */
function modelRejectsReasoningEffort(model: string): boolean {
  return /claude-haiku-4[-.]5/i.test(model)
}

/**
 * Models that require `thinking.type: "adaptive"` instead of the legacy
 * `"enabled"`. Matches Claude 4.7+ (Opus/Sonnet/Haiku at 4.7, 4.8, …).
 * Stay narrow: skips 4.5/4.6, only matches single-digit minor versions ≥ 7
 * to avoid false positives like a hypothetical 4.10 (would need re-check).
 */
function modelRequiresAdaptiveThinking(model: string): boolean {
  return /claude-(?:opus|sonnet|haiku)-4[-.][789](?:[-.]|$)/i.test(model)
}
