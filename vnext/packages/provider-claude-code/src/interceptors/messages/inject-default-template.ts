import { DEFAULT_TEMPLATE_BLOCK } from './system-blocks'
import type { MessagesBoundaryCtx } from './types'
import type { MessagesPayload } from '@vibe-llm/protocols/messages'

// Anthropic's prompt-caching API rejects requests with more than four
// `cache_control` markers; the budget is shared across system blocks, tools,
// and message content blocks.
const ANTHROPIC_CACHE_BREAKPOINT_CAP = 4

// Counts `cache_control` markers the caller has placed across tools, system
// array, and message content blocks. Billing and identity blocks injected
// earlier carry no `cache_control`, so they never contribute.
const countCacheBreakpoints = (payload: MessagesPayload): number => {
  let count = 0

  if (payload.tools) {
    for (const tool of payload.tools) {
      if ('cache_control' in tool && (tool as { cache_control?: unknown }).cache_control) count++
    }
  }

  if (Array.isArray(payload.system)) {
    for (const block of payload.system as Array<{ cache_control?: unknown }>) {
      if (block.cache_control) count++
    }
  }

  for (const message of payload.messages) {
    if (typeof message.content === 'string') continue
    for (const block of message.content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        'cache_control' in block &&
        (block as { cache_control?: unknown }).cache_control
      ) {
        count++
      }
    }
  }

  return count
}

// Appends cached default-template block at system[2]. Normally carries
// `cache_control:ephemeral+5m` so Anthropic's prompt cache keys on the
// (billing, identity, template) triplet. Billing sits BEFORE this breakpoint
// so per-request fingerprint never invalidates the cached prefix.
//
// When caller's payload is at/near the four-breakpoint cap, adding our own
// would trigger HTTP 400. Fallback: inject template text (three system
// blocks is a CC-shape requirement) but demote to un-cached.
export const injectDefaultTemplate = async <TResult>(
  _env: object,
  ctx: MessagesBoundaryCtx,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  if (!Array.isArray(ctx.payload.system)) {
    throw new Error(
      'inject-default-template: expected system to be an array (inject-billing-block must run first)',
    )
  }
  const system = ctx.payload.system
  const callerBreakpoints = countCacheBreakpoints(ctx.payload)
  const wouldOverflowBreakpointCap = callerBreakpoints >= ANTHROPIC_CACHE_BREAKPOINT_CAP
  const templateBlock = wouldOverflowBreakpointCap
    ? { type: 'text' as const, text: DEFAULT_TEMPLATE_BLOCK.text }
    : DEFAULT_TEMPLATE_BLOCK
  ctx.payload = { ...ctx.payload, system: [...system, templateBlock] }
  return await run()
}
