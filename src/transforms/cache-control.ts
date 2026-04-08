/**
 * Strip unsupported fields from cache_control in messages and system prompts
 *
 * Anthropic's prompt caching feature uses cache_control fields.
 * The upstream Copilot API supports basic cache_control (e.g. { type: "ephemeral" })
 * but rejects newer fields like "scope".
 *
 * This transform removes only the unsupported "scope" field while preserving
 * cache_control itself so that prompt caching can work.
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
 * Remove unsupported fields (scope) from cache_control on a content block
 */
function stripCacheControlScope(
  block: Record<string, unknown>,
  location: string,
  result: CacheControlStripResult,
): Record<string, unknown> {
  if (
    block &&
    typeof block === "object" &&
    "cache_control" in block &&
    block.cache_control &&
    typeof block.cache_control === "object"
  ) {
    const cc = block.cache_control as Record<string, unknown>
    if ("scope" in cc) {
      const { scope: _, ...rest } = cc
      block.cache_control = rest
      result.stripped = true
      result.count++
      result.locations.push(location)
    }
  }
  return block
}

/**
 * Strip unsupported cache_control fields from the payload
 * Works with any payload that has system and/or messages fields
 * Returns info about what was stripped for logging
 */
export function stripCacheControl(payload: Record<string, unknown>): CacheControlStripResult {
  const result: CacheControlStripResult = {
    stripped: false,
    count: 0,
    locations: [],
  }

  // Strip scope from system prompt (can be string or array of blocks)
  if (Array.isArray(payload.system)) {
    payload.system = payload.system.map((block, idx) =>
      typeof block === "object" && block !== null
        ? stripCacheControlScope(block as Record<string, unknown>, `system[${idx}]`, result)
        : block
    )
  }

  // Strip scope from messages
  const messages = payload.messages as Array<{ content?: unknown }> | undefined
  if (Array.isArray(messages)) {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message && Array.isArray(message.content)) {
        message.content = message.content.map((block, j) =>
          typeof block === "object" && block !== null
            ? stripCacheControlScope(
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
