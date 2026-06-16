/**
 * Inject Anthropic prompt-cache breakpoints into Messages payloads produced by
 * pairwise translators whose source protocol has no native `cache_control`
 * field. Without an explicit breakpoint the prompt cache stays cold.
 *
 * Up to 4 breakpoints are allowed per request; we use 3:
 *   1. system block (when non-empty)        — caches static instructions
 *   2. last custom tool definition           — caches the system+tools prefix
 *   3. last cacheable block of last message  — caches conversation history
 *
 * Reference: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */

export const EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' } as const

type CacheControl = { type: 'ephemeral' }
type Cacheable = { cache_control?: CacheControl }

type ToolLike = { name: string; type?: string } & Cacheable
type TextBlockLike = { type: 'text'; text: string } & Cacheable
export type ContentBlockLike = { type: string } & Cacheable
export type MessageLike = { role: 'user' | 'assistant'; content: string | ContentBlockLike[] }

const CACHEABLE_BLOCK_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result'])

export function applyLastToolCacheBreakpoint(tools: ToolLike[] | undefined): void {
  if (!tools || tools.length === 0) return
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i]
    if (!tool) continue
    // Native server-side tools (web_search_*, computer_*) carry a discriminant
    // `type`; cache_control belongs on the last *custom* tool. A missing
    // `type` or `type === "custom"` qualifies as a custom tool.
    if (!tool.type || tool.type === 'custom') {
      tool.cache_control = EPHEMERAL_CACHE_CONTROL
      return
    }
  }
}

export function applyLastMessageCacheBreakpoint(messages: MessageLike[]): void {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]
    if (!message) continue
    if (typeof message.content === 'string') {
      const block: TextBlockLike = {
        type: 'text',
        text: message.content,
        cache_control: EPHEMERAL_CACHE_CONTROL,
      }
      message.content = [block]
      return
    }
    for (let b = message.content.length - 1; b >= 0; b--) {
      const block = message.content[b]
      if (block && CACHEABLE_BLOCK_TYPES.has(block.type)) {
        block.cache_control = EPHEMERAL_CACHE_CONTROL
        return
      }
    }
  }
}

/**
 * Promote a system string into a single text block carrying a cache breakpoint.
 * Returns undefined for empty input so callers can pass-through.
 */
export function systemWithCacheBreakpoint(text: string | undefined): TextBlockLike[] | undefined {
  if (!text) return undefined
  return [{ type: 'text', text, cache_control: EPHEMERAL_CACHE_CONTROL }]
}
