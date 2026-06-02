/**
 * Inject Anthropic prompt-cache breakpoints into Messages payloads produced by
 * translators whose source protocol has no native `cache_control` field.
 *
 * Without an explicit breakpoint somewhere in the request, Anthropic's prompt
 * cache stays cold (`cache_read_input_tokens=0`) regardless of how stable the
 * prefix is. Source protocols that drop through translation:
 *   - Responses (opaque `prompt_cache_key`)
 *   - Chat Completions (no caching field at all)
 *   - Gemini (composes through Chat Completions)
 *
 * Up to 4 breakpoints are allowed per request; we use 3 and leave one for
 * downstream additions:
 *   1. system block (when non-empty)        — caches static instructions
 *   2. last custom tool definition           — caches the system+tools prefix
 *   3. last cacheable block of last message  — caches conversation history
 *
 * Reference: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */

import type {
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicTool,
} from "~/transforms/types"

export const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const

type Cacheable = { cache_control?: { type: "ephemeral" } }

export function applyLastToolCacheBreakpoint(
  tools: AnthropicTool[] | undefined,
): void {
  if (!tools || tools.length === 0) return
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i] as AnthropicTool & Cacheable
    // Native server-side tools (web_search_*, computer_*, etc.) carry a
    // discriminant `type`; cache_control belongs on the last *custom* tool.
    if (!tool.type || tool.type === "custom") {
      tool.cache_control = EPHEMERAL_CACHE_CONTROL
      return
    }
  }
}

function isCacheableBlockType(t: string): boolean {
  return t === "text" || t === "image" || t === "tool_use" || t === "tool_result"
}

export function applyLastMessageCacheBreakpoint(
  messages: AnthropicMessage[],
): void {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]
    if (!message) continue
    if (typeof message.content === "string") {
      const block: AnthropicTextBlock & Cacheable = {
        type: "text",
        text: message.content,
        cache_control: EPHEMERAL_CACHE_CONTROL,
      }
      message.content = [block as AnthropicContentBlock]
      return
    }
    for (let b = message.content.length - 1; b >= 0; b--) {
      const block = message.content[b] as (AnthropicContentBlock & Cacheable) | undefined
      if (block && isCacheableBlockType(block.type)) {
        block.cache_control = EPHEMERAL_CACHE_CONTROL
        return
      }
    }
  }
}

/**
 * Promote a system string into a single text block carrying a cache breakpoint.
 * Pass-through (undefined) when there's no system text.
 */
export function systemWithCacheBreakpoint(
  text: string | undefined,
): AnthropicTextBlock[] | undefined {
  if (!text) return undefined
  const block: AnthropicTextBlock & Cacheable = {
    type: "text",
    text,
    cache_control: EPHEMERAL_CACHE_CONTROL,
  }
  return [block]
}
