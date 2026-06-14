/**
 * Port the top-level Anthropic `cache_control` field onto the last cacheable
 * content block, mirroring the documented `MessageCreateParamsBase` semantics
 * ("automatically applies a cache_control marker to the last cacheable block").
 *
 * Why: stricter Copilot Messages slots (haiku-4.5, sonnet-4.5/4.6, intermittently
 * opus-4.5) validate against an older schema and reject the top-level field
 * with `cache_control: Extra inputs are not permitted`. Newer slots silently
 * accept it. Reproducing the SDK's auto-apply on the gateway side gives
 * uniform behavior across slots and matches what Zed's native Anthropic
 * provider expects.
 *
 * If the chosen block already carries its own `cache_control`, leave it alone
 * — an explicit marker wins over the auto-apply. Sub-field extensions
 * (`scope`, `ttl`) carried in the ported value are cleaned up by
 * `stripCacheControl`, which runs immediately after.
 *
 * Cacheable block types: text, image, tool_use, tool_result.
 */

const CACHEABLE_BLOCK_TYPES = new Set(["text", "image", "tool_use", "tool_result"])

export function applyTopLevelCacheControl(payload: Record<string, unknown>): boolean {
  const topLevel = payload.cache_control
  if (topLevel === undefined) return false

  delete payload.cache_control

  const messages = payload.messages as Array<{ content?: unknown }> | undefined
  if (!Array.isArray(messages)) return true

  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]
    if (!message) continue

    // String content: lift into a single text block and attach.
    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content, cache_control: topLevel }] as unknown as typeof message.content
      return true
    }

    if (!Array.isArray(message.content)) continue

    for (let b = message.content.length - 1; b >= 0; b--) {
      const block = message.content[b] as Record<string, unknown> | undefined
      if (!block || typeof block !== "object") continue
      const type = block.type
      if (typeof type !== "string" || !CACHEABLE_BLOCK_TYPES.has(type)) continue
      if (block.cache_control === undefined) {
        block.cache_control = topLevel
      }
      return true
    }
  }

  return true
}
