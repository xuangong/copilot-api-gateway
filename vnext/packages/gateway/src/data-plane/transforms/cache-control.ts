/**
 * Neutralize cache_control extensions that strict Anthropic Messages slots reject.
 *
 * Two sub-fields are beta extensions to the base `CacheControlEphemeral` shape
 * that Copilot's stricter Messages-upstream deployments (claude-haiku-4.5,
 * claude-sonnet-4.5/4.6, intermittently claude-opus-4.5) reject:
 *
 *   - `scope`: added by the `prompt-caching-scope-2025-11-27` beta.
 *     Upstream returns `cache_control.scope: Extra inputs are not permitted`.
 *   - `ttl`:   added by the `extended-cache-ttl-2025-04-11` beta. That beta is
 *     not on Copilot's accepted allow-list either, so any `ttl` trips the
 *     same schema rejection.
 *
 * Walk every position where `cache_control` may appear — system blocks,
 * tools, message content blocks including `tool_use`/`tool_result` — strip
 * both sub-fields, keep `{ type: "ephemeral" }` so prompt caching still
 * primes on lenient slots, and drop `cache_control` entirely if nothing
 * recognisable survives.
 *
 * The top-level `cache_control` field (which Anthropic auto-applies to the
 * last cacheable block) is handled by `applyTopLevelCacheControl`, which
 * runs immediately BEFORE this transform and ports it onto the last cacheable
 * block. This stripper then cleans whatever extensions came along for the
 * ride.
 *
 * References:
 *   - https://github.com/anthropics/anthropic-sdk-typescript (MessageCreateParamsBase)
 *   - https://github.com/caozhiyuan/copilot-api/issues/143
 *   - https://github.com/caozhiyuan/copilot-api/issues/144
 *   - https://github.com/caozhiyuan/copilot-api/issues/269
 */

export interface CacheControlStripResult {
  stripped: boolean
  count: number
  locations: string[] // e.g., ["system[0]", "messages[2].content[1]", "tools[0]"]
}

function stripExtensions(
  block: Record<string, unknown>,
  location: string,
  result: CacheControlStripResult,
): void {
  if (!block || typeof block !== "object") return
  const cc = block.cache_control
  if (!cc || typeof cc !== "object") return

  const { scope: _scope, ttl: _ttl, ...rest } = cc as Record<string, unknown>
  const hadExt = "scope" in (cc as Record<string, unknown>) || "ttl" in (cc as Record<string, unknown>)
  if (!hadExt) return

  if (Object.keys(rest).length > 0) {
    block.cache_control = rest
  } else {
    delete block.cache_control
  }
  result.stripped = true
  result.count++
  result.locations.push(location)
}

/**
 * Strip unsupported cache_control sub-fields (`scope`, `ttl`) from system,
 * tools, and message content blocks. Returns info about what was stripped.
 */
export function stripCacheControl(payload: Record<string, unknown>): CacheControlStripResult {
  const result: CacheControlStripResult = { stripped: false, count: 0, locations: [] }

  if (Array.isArray(payload.system)) {
    payload.system.forEach((block, i) => {
      if (block && typeof block === "object") {
        stripExtensions(block as Record<string, unknown>, `system[${i}]`, result)
      }
    })
  }

  if (Array.isArray(payload.tools)) {
    payload.tools.forEach((tool, i) => {
      if (tool && typeof tool === "object") {
        stripExtensions(tool as Record<string, unknown>, `tools[${i}]`, result)
      }
    })
  }

  const messages = payload.messages as Array<{ content?: unknown }> | undefined
  if (Array.isArray(messages)) {
    messages.forEach((message, i) => {
      if (message && Array.isArray(message.content)) {
        message.content.forEach((block, j) => {
          if (block && typeof block === "object") {
            stripExtensions(
              block as Record<string, unknown>,
              `messages[${i}].content[${j}]`,
              result,
            )
          }
        })
      }
    })
  }

  return result
}
