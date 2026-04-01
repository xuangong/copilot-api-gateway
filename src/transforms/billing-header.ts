import type { AnthropicMessagesPayload } from "./types"

/**
 * Copilot API rejects requests containing this string in system prompts
 */
const RESERVED_KEYWORD = "x-anthropic-billing-header"

/**
 * Strip reserved keywords from Anthropic Messages payload
 * This prevents Copilot API from rejecting requests
 */
export function stripReservedKeywords(
  payload: AnthropicMessagesPayload,
): void {
  // Strip from system prompt
  if (typeof payload.system === "string") {
    payload.system = payload.system.replaceAll(RESERVED_KEYWORD, "")
  } else if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      block.text = block.text.replaceAll(RESERVED_KEYWORD, "")
    }
  }

  // Strip from messages
  for (const msg of payload.messages) {
    if (typeof msg.content === "string") {
      msg.content = msg.content.replaceAll(RESERVED_KEYWORD, "")
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") {
          block.text = block.text.replaceAll(RESERVED_KEYWORD, "")
        }
      }
    }
  }
}
