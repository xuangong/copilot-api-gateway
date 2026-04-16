import type {
  AnthropicMessagesPayload,
  AnthropicThinkingBlock,
} from "./types"

const THINKING_PLACEHOLDER = "Thinking..."

/**
 * Filter invalid thinking blocks for native Messages API.
 * Invalid: empty thinking, "Thinking..." placeholder.
 */
export function filterThinkingBlocks(
  payload: AnthropicMessagesPayload,
): void {
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
 * For Claude 4.7+ models, convert thinking.type "enabled" to "adaptive"
 * and use output_config.effort instead.
 * These models don't support thinking.type "enabled".
 */
export function adaptThinkingForModel(
  payload: AnthropicMessagesPayload,
): void {
  if (!payload.thinking || !payload.model) return

  const is47Model = payload.model.includes("4-7") || payload.model.includes("4.7")

  if (!is47Model) return

  if (payload.thinking.type === "enabled") {
    payload.thinking.type = "adaptive"
    delete payload.thinking.budget_tokens
    if (!payload.output_config) {
      payload.output_config = { effort: "medium" }
    }
  }
}
