/**
 * Strip Anthropic Claude Code's per-turn billing-attribution block from
 * `payload.system` before forwarding to upstream.
 *
 * Claude Code clients seed every Messages request with an
 * `x-anthropic-billing-header: …` line carrying a per-turn `cch=<hash>`
 * value. Two upstreams want opposite things from that block:
 *
 *   - The Claude Code subscription endpoint reads the block to bill the
 *     request against the user's plan tier. If we strip it, the request
 *     silently falls off plan billing.
 *   - Every other upstream (copilot, azure, custom) treats the block as
 *     ordinary prompt text. The `cch=` hash flips per call, so the
 *     upstream's prompt-cache layer sees a "different" prompt every turn
 *     and never reuses its cache, even when the real conversation prefix
 *     hasn't changed.
 *
 * Gating: `strip-billing-attribution` flag on `Invocation.enabledFlags`.
 * The flag defaults on for `copilot`, `azure`, `custom` upstream kinds.
 * When the (currently non-existent in vNext) claude-code provider ever
 * lands, its default must remain OFF.
 *
 * Adapted from copilot-gateway
 * `packages/gateway/src/data-plane/chat/messages/interceptors/strip-billing-attribution.ts`.
 * Same regex + same two `system` shapes; vNext-style flag gate replaces the
 * reference's `providerModelOf(ctx.candidate).enabledFlags.has(...)`.
 */
import type { MessagesInterceptor } from './types'

const BILLING_HEADER_LINE_RE = /x-anthropic-billing-header[^\n]*/g
const CCH_HASH_RE = /cch=[0-9a-f]{5,};?/gi

const stripText = (text: string): string =>
  text.replace(BILLING_HEADER_LINE_RE, '').replace(CCH_HASH_RE, '').trim()

interface SystemPayload {
  system?: unknown
  [k: string]: unknown
}

interface SystemBlock {
  text: string
  [k: string]: unknown
}

const isSystemBlock = (v: unknown): v is SystemBlock =>
  typeof v === 'object' && v !== null && typeof (v as { text?: unknown }).text === 'string'

export const withBillingAttributionStripped: MessagesInterceptor = async (inv, _ctx, run) => {
  if (!inv.enabledFlags.has('strip-billing-attribution')) return run()

  const payload = inv.payload as SystemPayload
  const system = payload.system

  if (typeof system === 'string') {
    const stripped = stripText(system)
    if (stripped.length > 0) {
      payload.system = stripped
    } else {
      delete payload.system
    }
  } else if (Array.isArray(system)) {
    const blocks = system
      .filter(isSystemBlock)
      .map((block) => ({ ...block, text: stripText(block.text) }))
      .filter((block) => block.text.length > 0)
    if (blocks.length > 0) {
      payload.system = blocks
    } else {
      delete payload.system
    }
  }

  return run()
}
