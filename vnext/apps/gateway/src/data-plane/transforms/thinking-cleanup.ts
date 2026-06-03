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
 *
 * For models that don't support reasoning effort at all (e.g. claude-haiku-4.5),
 * strip output_config.effort so the upstream Copilot API doesn't reject the request.
 */
export function adaptThinkingForModel(
  payload: AnthropicMessagesPayload,
): void {
  if (!payload.model) return

  // Models that don't support output_config.effort / reasoning effort.
  // Upstream Copilot returns 400 invalid_reasoning_effort otherwise.
  // These models also don't support thinking.type "adaptive" — only
  // "enabled" / "disabled". Normalize both fields here.
  if (modelRejectsReasoningEffort(payload.model)) {
    // output_config is a Copilot/Claude-4.7 private extension. For models that
    // don't support it, the upstream (Vertex/Anthropic) rejects the whole field
    // with "Extra inputs are not permitted" — drop it entirely, not just .effort.
    if (payload.output_config) {
      delete payload.output_config
    }
    if (payload.thinking?.type === "adaptive") {
      payload.thinking.type = "enabled"
      if (!payload.thinking.budget_tokens) {
        // "enabled" requires budget_tokens; pick a safe default.
        payload.thinking.budget_tokens = 1024
      }
    }
    return
  }

  if (!payload.thinking) return

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

function modelRejectsReasoningEffort(model: string): boolean {
  // Claude Haiku 4.5 (and dated variants like claude-haiku-4-5-20251001)
  return /claude-haiku-4[-.]5/i.test(model)
}
