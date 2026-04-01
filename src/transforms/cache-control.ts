/**
 * Strip cache_control fields from messages and system prompts
 *
 * Anthropic's prompt caching feature uses cache_control fields, but
 * the upstream Copilot API doesn't support them. This transform removes
 * these fields to prevent "Extra inputs are not permitted" errors.
 *
 * Example error without this transform:
 * "system.2.cache_control.ephemeral.scope: Extra inputs are not permitted"
 */

export interface CacheControlStripResult {
  stripped: boolean
  count: number
  locations: string[] // e.g., ["system[0]", "messages[2].content[1]"]
}

/**
 * Remove cache_control from a content block
 */
function stripCacheControlFromBlock(
  block: Record<string, unknown>,
  location: string,
  result: CacheControlStripResult,
): Record<string, unknown> {
  if (block && typeof block === "object" && "cache_control" in block) {
    const { cache_control: _, ...rest } = block
    result.stripped = true
    result.count++
    result.locations.push(location)
    return rest
  }
  return block
}

/**
 * Strip cache_control fields from the payload
 * Works with any payload that has system and/or messages fields
 * Returns info about what was stripped for logging
 */
export function stripCacheControl(payload: Record<string, unknown>): CacheControlStripResult {
  const result: CacheControlStripResult = {
    stripped: false,
    count: 0,
    locations: [],
  }

  // Strip from system prompt (can be string or array of blocks)
  if (Array.isArray(payload.system)) {
    payload.system = payload.system.map((block, idx) =>
      typeof block === "object" && block !== null
        ? stripCacheControlFromBlock(block as Record<string, unknown>, `system[${idx}]`, result)
        : block
    )
  }

  // Strip from messages
  const messages = payload.messages as Array<{ content?: unknown }> | undefined
  if (Array.isArray(messages)) {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message && Array.isArray(message.content)) {
        message.content = message.content.map((block, j) =>
          typeof block === "object" && block !== null
            ? stripCacheControlFromBlock(
                block as Record<string, unknown>,
                `messages[${i}].content[${j}]`,
                result
              )
            : block
        )
      }
    }
  }

  return result
}
