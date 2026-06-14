import type { AnthropicMessagesPayload } from "./types"

/**
 * Claude Code injects `x-anthropic-billing-header` lines containing a
 * per-turn `cch=<hash>`. Copilot's upstream Messages endpoint treats this
 * header text as ordinary prompt content, so the rotating hash invalidates
 * the prompt-cache key on every request — opus-4.7 traffic showed every
 * call as a fresh cache_creation with zero cache_read.
 *
 * Mirrors copilot-gateway's strip-billing-attribution interceptor.
 */
const BILLING_HEADER_LINE_RE = /x-anthropic-billing-header[^\n]*/g
const CCH_HASH_RE = /cch=[0-9a-f]{5,};?/gi

function stripText(text: string): string {
  return text.replace(BILLING_HEADER_LINE_RE, "").replace(CCH_HASH_RE, "")
}

/**
 * Strip Claude Code billing-attribution noise from Anthropic Messages
 * payload so the prompt-cache prefix stays stable across turns.
 */
export function stripReservedKeywords(
  payload: AnthropicMessagesPayload,
): void {
  if (typeof payload.system === "string") {
    payload.system = stripText(payload.system).trim()
    if (!payload.system) delete payload.system
  } else if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      block.text = stripText(block.text).trim()
    }
    payload.system = payload.system.filter((block) => block.text.length > 0)
    if (payload.system.length === 0) delete payload.system
  }

  for (const msg of payload.messages) {
    if (typeof msg.content === "string") {
      msg.content = stripText(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") {
          block.text = stripText(block.text)
        }
      }
    }
  }
}
