/**
 * Inject Anthropic `cache_control: { type: "ephemeral" }` breakpoints into
 * /v1/messages payloads translated from non-Anthropic source protocols so
 * the upstream's prompt cache can hit on stable prefixes.
 *
 * Selection rules (conservative, deduplicated, respecting Anthropic's
 * 4-breakpoint ceiling):
 *   1. Last text block of the system field (string promoted to one block).
 *   2. Last entry of the tools array (only when tools.length >= 3).
 *   3. Last text/tool_result block of the second-to-last user message
 *      (so the trailing user turn benefits from the cached prefix).
 *
 * If ANY block in the payload already carries cache_control, we treat the
 * caller as having full control and skip injection entirely — never
 * overwrite a hand-tuned cache plan.
 */

import type {
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicContentBlock,
  AnthropicTool,
} from "./types"

const MAX_BREAKPOINTS = 4
const TOOL_BREAKPOINT_MIN_COUNT = 3

type Cacheable = { cache_control?: { type: "ephemeral" } }

function hasAnyExistingBreakpoint(payload: AnthropicMessagesPayload): boolean {
  if (Array.isArray(payload.system)) {
    for (const b of payload.system) if ((b as Cacheable).cache_control) return true
  }
  if (Array.isArray(payload.tools)) {
    for (const t of payload.tools) if ((t as Cacheable).cache_control) return true
  }
  for (const m of payload.messages) {
    if (typeof m.content === "string") continue
    for (const b of m.content) if ((b as Cacheable).cache_control) return true
  }
  return false
}

function promoteSystemToBlocks(
  payload: AnthropicMessagesPayload,
): AnthropicTextBlock[] | null {
  if (Array.isArray(payload.system)) return payload.system
  if (typeof payload.system === "string" && payload.system.length > 0) {
    const blocks: AnthropicTextBlock[] = [{ type: "text", text: payload.system }]
    payload.system = blocks
    return blocks
  }
  return null
}

function markSystem(payload: AnthropicMessagesPayload): boolean {
  const blocks = promoteSystemToBlocks(payload)
  if (!blocks || blocks.length === 0) return false
  const last = blocks[blocks.length - 1] as AnthropicTextBlock & Cacheable
  last.cache_control = { type: "ephemeral" }
  return true
}

function markTools(tools: AnthropicTool[] | undefined): boolean {
  if (!Array.isArray(tools) || tools.length < TOOL_BREAKPOINT_MIN_COUNT) return false
  const last = tools[tools.length - 1] as AnthropicTool & Cacheable
  last.cache_control = { type: "ephemeral" }
  return true
}

function markSecondToLastUserTurn(payload: AnthropicMessagesPayload): boolean {
  const userIdx: number[] = []
  for (let i = 0; i < payload.messages.length; i++) {
    if (payload.messages[i]!.role === "user") userIdx.push(i)
  }
  if (userIdx.length < 2) return false
  const target = payload.messages[userIdx[userIdx.length - 2]!]!
  if (typeof target.content === "string") {
    target.content = [{ type: "text", text: target.content }]
  }
  const blocks = target.content as Array<AnthropicContentBlock & Cacheable>
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!
    if (b.type === "text" || b.type === "tool_result") {
      b.cache_control = { type: "ephemeral" }
      return true
    }
  }
  return false
}

export interface CacheBreakpointInjectionResult {
  injected: number
  skippedExisting: boolean
}

export function attachMessagesCacheBreakpoints(
  payload: AnthropicMessagesPayload,
): CacheBreakpointInjectionResult {
  if (!payload || !Array.isArray(payload.messages)) {
    return { injected: 0, skippedExisting: false }
  }
  if (hasAnyExistingBreakpoint(payload)) {
    return { injected: 0, skippedExisting: true }
  }
  let injected = 0
  if (markSystem(payload)) injected++
  if (injected < MAX_BREAKPOINTS && markTools(payload.tools)) injected++
  if (injected < MAX_BREAKPOINTS && markSecondToLastUserTurn(payload)) injected++
  return { injected, skippedExisting: false }
}
