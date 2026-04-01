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
