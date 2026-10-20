/**
 * Per-model pricing table for Copilot upstream.
 *
 * USD per million tokens, aligned with sst/models.dev `Cost` schema:
 * https://github.com/sst/models.dev/blob/main/packages/core/src/schema.ts
 *
 * Source of truth for updates:
 * https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 */

import type { ModelPricing } from "~/protocols/common"

type PricingRule = readonly [key: string | RegExp, pricing: ModelPricing]

const CLAUDE_VARIANT_SUFFIX = /-(?:high|xhigh|1m(?:-internal)?)$/
// Claude advertises dates as `-20251001`; OpenAI/Copilot ship `-2026-04-23`.
// Strip both before pricing lookup so dated snapshots fall back to the base id.
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/

/** Convert raw upstream model id to the public id used as pricing key. */
export function copilotPublicModelId(id: string): string {
  const dateless = id.replace(DATE_SUFFIX, "")
  if (!dateless.startsWith("claude-")) return dateless
  return dateless
    .replace(/(?<=-)(\d+)-(\d+)(?=-|$)/g, "$1.$2")
    .replace(CLAUDE_VARIANT_SUFFIX, "")
    .replace(/(\d)\.(\d)/g, "$1-$2")
}

const COPILOT_MODEL_PRICING: readonly PricingRule[] = [
  // Claude 5/5.5 verified against the docs page on 2026-10-20. Haiku 5.5 also
  // has a > 100K input "Long context" band (0.5 / 0.05 / 0.625 / 2.5); this
  // table is single-tier, so only the default band is billed.
  ["claude-opus-5", { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 }],
  ["claude-opus-5-5", { input: 4, cache_read: 0.2, cache_write: 5, output: 20 }],
  ["claude-sonnet-5", { input: 2, cache_read: 0.2, cache_write: 2.5, output: 10 }],
  ["claude-sonnet-5-5", { input: 2, cache_read: 0.1, cache_write: 2.5, output: 10 }],
  ["claude-haiku-5-5", { input: 0.1, cache_read: 0.01, cache_write: 0.125, output: 0.5 }],
  ["claude-fable-5", { input: 10, cache_read: 1, cache_write: 12.5, output: 50 }],
  ["claude-fable-5-1", { input: 10, cache_read: 0.25, cache_write: 12.5, output: 50 }],
  ["claude-opus-4-8-fast", { input: 10, cache_read: 1, cache_write: 12.5, output: 50 }],
  [/^claude-opus-4-[5-8]$/, { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 }],
  [/^claude-sonnet-4(-[56])?$/, { input: 3, cache_read: 0.3, cache_write: 3.75, output: 15 }],
  ["claude-haiku-4-5", { input: 1, cache_read: 0.1, cache_write: 1.25, output: 5 }],
  // Default-tier rates mirrored from the vnext catalog
  // (vnext/packages/provider-copilot/src/pricing.ts), which also records the
  // long-context bands and per-row provenance.
  ["gpt-6.1-sol", { input: 2, cache_read: 0.1, cache_write: 2.5, output: 10 }],
  ["gpt-6-astra", { input: 10, cache_read: 1, cache_write: 12.5, output: 50 }],
  ["gpt-6-sol", { input: 2, cache_read: 0.2, cache_write: 2.5, output: 10 }],
  ["gpt-6-luna", { input: 0.1, cache_read: 0.01, cache_write: 0.125, output: 0.5 }],
  ["gpt-5.6-sol", { input: 4, cache_read: 0.4, cache_write: 5, output: 20 }],
  ["gpt-5.6-sol-fast", { input: 4, cache_read: 0.4, cache_write: 5, output: 20 }],
  ["gpt-5.6-terra", { input: 2, cache_read: 0.2, cache_write: 2.5, output: 12 }],
  ["gpt-5.6-luna", { input: 0.2, cache_read: 0.02, cache_write: 0.25, output: 1.2 }],
  ["gpt-5.5", { input: 5, cache_read: 0.5, output: 30 }],
  ["gpt-5.4", { input: 2.5, cache_read: 0.25, output: 15 }],
  ["gpt-5.4-mini", { input: 0.75, cache_read: 0.075, output: 4.5 }],
  ["gpt-5.4-nano", { input: 0.2, cache_read: 0.02, output: 1.25 }],
  [/^gpt-5[.][23](-codex)?$/, { input: 1.75, cache_read: 0.175, output: 14 }],
  ["gpt-5.1-codex-mini", { input: 0.25, cache_read: 0.025, output: 2 }],
  [/^gpt-5[.]1/, { input: 1.25, cache_read: 0.125, output: 10 }],
  ["gpt-5-mini", { input: 0.25, cache_read: 0.025, output: 2 }],
  [/^gpt-4[.]1/, { input: 2, cache_read: 0.5, output: 8 }],
  ["gpt-41-copilot", { input: 2, cache_read: 0.5, output: 8 }],
  [/^gpt-4o(-[0-9]{4}-[0-9]{2}-[0-9]{2})?$/, { input: 2.5, cache_read: 1.25, output: 10 }],
  ["gpt-4-o-preview", { input: 2.5, cache_read: 1.25, output: 10 }],
  [/^gpt-4o-mini/, { input: 0.15, cache_read: 0.075, output: 0.6 }],
  [/^gpt-4(-0613)?$/, { input: 30, output: 60 }],
  ["gpt-4-0125-preview", { input: 10, output: 30 }],
  ["gpt-3.5-turbo", { input: 0.5, output: 1.5 }],
  ["gpt-3.5-turbo-0613", { input: 1.5, output: 2 }],
  ["gemini-2.5-pro", { input: 1.25, cache_read: 0.125, output: 10 }],
  ["gemini-3-flash-preview", { input: 0.5, cache_read: 0.05, output: 3 }],
  ["gemini-3.1-pro-preview", { input: 2, cache_read: 0.2, output: 12 }],
  ["gemini-3.5-flash", { input: 1.5, cache_read: 0.15, output: 9 }],
  // Promotional rates: 3.x Flash until 2026-12-31, 4 Argon until 2026-12-01.
  [/^gemini-3[.][678]-flash$/, { input: 0.75, cache_read: 0.075, output: 3.75 }],
  ["gemini-4-argon", { input: 2, cache_read: 0.1, output: 10 }],
  [/^grok-code-fast/, { input: 0.2, output: 1.5 }],
  [/^grok-4[.][567]$/, { input: 2, cache_read: 0.5, output: 6 }],
  ["mai-code-1.1-flash", { input: 0.2, cache_read: 0.02, output: 1.2 }],
  ["mai-code-1-flash", { input: 0.75, cache_read: 0.075, output: 4.5 }],
  ["kimi-k2.7-code", { input: 0.95, cache_read: 0.19, output: 4 }],
  ["kimi-k3", { input: 3, cache_read: 0.3, output: 15 }],
  ["goldeneye", { input: 1.25, cache_read: 0.125, output: 10 }],
  ["raptor-mini", { input: 0.25, cache_read: 0.025, output: 2 }],
  ["minimax-m2.5", { input: 0.3, output: 1.2 }],
  [/^text-embedding-3-small/, { input: 0.02, output: 0 }],
  ["text-embedding-ada-002", { input: 0.1, output: 0 }],
]

function matchPricing(publicName: string): ModelPricing | null {
  for (const [key, pricing] of COPILOT_MODEL_PRICING) {
    if (typeof key === "string" ? publicName === key : key.test(publicName)) return pricing
  }
  return null
}

/** Lookup by post-variant-merge public id (e.g. `claude-opus-4-7`). */
export function pricingForCopilotPublicModelId(publicName: string): ModelPricing | null {
  return matchPricing(publicName)
}

/** Lookup by raw model id from logs (variant suffix/date stripped). */
export function pricingForCopilotModelKey(modelKey: string): ModelPricing | null {
  return matchPricing(copilotPublicModelId(modelKey))
}
