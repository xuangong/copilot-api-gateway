/**
 * Per-public-model pricing catalog used by the Copilot provider. `match` targets
 * the public model id that survives Claude variant merging (e.g.
 * `claude-opus-4-7`, `gpt-5.4`). `pricingForCopilotModelKey` strips raw-id
 * variant suffixes (`-high`, `-xhigh`, `-1m`, `-1m-internal`, trailing date)
 * using the same rules as `copilotPublicModelId` in variants.ts so it can be
 * fed the modelKey persisted in `usage.model_key`. Values are USD per million
 * tokens, aligned with sst/models.dev `Cost`.
 *
 * `tiers[0]` is the default tier and is the only tier billing reads. Later
 * tiers are the long-context bands GitHub publishes; they are displayed by the
 * dashboard Pricing tab but are not yet billed (see the design spec).
 *
 * The entry list is order-sensitive: the first matcher that hits wins, so a
 * specific id must precede any prefix regex that would also match it.
 *
 * Source of truth for Copilot pricing updates: COPILOT_PRICING_SOURCE below.
 */

import { copilotPublicModelId } from "./variants"
import type { ModelPricing } from "@vibe-llm/protocols/common"

export const COPILOT_PRICING_SOURCE = {
  url: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
  verifiedOn: "2026-08-12",
} as const

export interface PricingTier {
  /** Tier name as printed in the docs, e.g. "Default", "Long context". */
  readonly label: string
  /** Input-token count above which this tier applies. Absent on the default tier. */
  readonly contextThreshold?: number
  readonly pricing: ModelPricing
}

export interface CopilotModelPricing {
  /**
   * Model name exactly as printed in the docs, e.g. "GPT-5.5". Absent when the
   * entry exists only to price a model the docs no longer list.
   */
  readonly displayName?: string
  /** Matcher against the public model id. */
  readonly match: string | RegExp
  readonly tiers: readonly PricingTier[]
}

const only = (pricing: ModelPricing): readonly PricingTier[] => [{ label: "Default", pricing }]

const COPILOT_MODEL_PRICING: readonly CopilotModelPricing[] = [
  // Claude ids may appear in either dot form (`claude-opus-4.7`, Copilot raw)
  // or dash form (`claude-opus-4-7`, Anthropic public id), so the matchers
  // accept `[.-]`.
  { match: /^claude-opus-4[.-][5678]$/, tiers: only({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }) },
  { match: /^claude-opus-5([.-]\d)?$/, tiers: only({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }) },
  { match: /^claude-sonnet-4([.-][56])?$/, tiers: only({ input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15 }) },
  { match: /^claude-sonnet-5([.-]\d)?$/, tiers: only({ input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 10 }) },
  { match: /^claude-fable-5([.-]\d)?$/, tiers: only({ input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 50 }) },
  { match: /^claude-haiku-4[.-]5$/, tiers: only({ input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 5 }) },
  { match: "gpt-5.6-sol", tiers: only({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 }) },
  { match: "gpt-5.6-terra", tiers: only({ input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 12 }) },
  { match: "gpt-5.6-luna", tiers: only({ input: 0.2, input_cache_read: 0.02, input_cache_write: 0.25, output: 1.2 }) },
  { match: "gpt-5.5", tiers: only({ input: 5, input_cache_read: 0.5, output: 30 }) },
  { match: "gpt-5.4", tiers: only({ input: 2.5, input_cache_read: 0.25, output: 15 }) },
  { match: "gpt-5.4-mini", tiers: only({ input: 0.75, input_cache_read: 0.075, output: 4.5 }) },
  { match: "gpt-5.4-nano", tiers: only({ input: 0.2, input_cache_read: 0.02, output: 1.25 }) },
  { match: /^gpt-5[.][23](-codex)?$/, tiers: only({ input: 1.75, input_cache_read: 0.175, output: 14 }) },
  { match: "gpt-5.1-codex-mini", tiers: only({ input: 0.25, input_cache_read: 0.025, output: 2 }) },
  { match: /^gpt-5[.]1/, tiers: only({ input: 1.25, input_cache_read: 0.125, output: 10 }) },
  { match: "gpt-5-mini", tiers: only({ input: 0.25, input_cache_read: 0.025, output: 2 }) },
  { match: /^gpt-4[.]1/, tiers: only({ input: 2, input_cache_read: 0.5, output: 8 }) },
  { match: "gpt-41-copilot", tiers: only({ input: 2, input_cache_read: 0.5, output: 8 }) },
  { match: /^gpt-4o(-[0-9]{4}-[0-9]{2}-[0-9]{2})?$/, tiers: only({ input: 2.5, input_cache_read: 1.25, output: 10 }) },
  { match: "gpt-4-o-preview", tiers: only({ input: 2.5, input_cache_read: 1.25, output: 10 }) },
  { match: /^gpt-4o-mini/, tiers: only({ input: 0.15, input_cache_read: 0.075, output: 0.6 }) },
  { match: /^gpt-4(-0613)?$/, tiers: only({ input: 30, output: 60 }) },
  { match: "gpt-4-0125-preview", tiers: only({ input: 10, output: 30 }) },
  { match: "gpt-3.5-turbo", tiers: only({ input: 0.5, output: 1.5 }) },
  { match: "gpt-3.5-turbo-0613", tiers: only({ input: 1.5, output: 2 }) },
  { match: "gemini-2.5-pro", tiers: only({ input: 1.25, input_cache_read: 0.125, output: 10 }) },
  { match: "gemini-3-flash-preview", tiers: only({ input: 0.5, input_cache_read: 0.05, output: 3 }) },
  { match: "gemini-3.1-pro-preview", tiers: only({ input: 2, input_cache_read: 0.2, output: 12 }) },
  { match: "gemini-3.5-flash", tiers: only({ input: 1.5, input_cache_read: 0.15, output: 9 }) },
  { match: "gemini-3.6-flash", tiers: only({ input: 1.5, input_cache_read: 0.15, output: 7.5 }) },
  { match: /^grok-code-fast/, tiers: only({ input: 0.2, output: 1.5 }) },
  { match: /^grok-4[.]5/, tiers: only({ input: 2, input_cache_read: 0.5, output: 6 }) },
  { match: /^mai-code-1-flash/, tiers: only({ input: 0.75, input_cache_read: 0.075, output: 4.5 }) },
  { match: /^kimi-k2[.]7-code/, tiers: only({ input: 0.95, input_cache_read: 0.19, output: 4 }) },
  { match: /^kimi-k3/, tiers: only({ input: 3, input_cache_read: 0.3, output: 15 }) },
  { match: "goldeneye", tiers: only({ input: 1.25, input_cache_read: 0.125, output: 10 }) },
  { match: "raptor-mini", tiers: only({ input: 0.25, input_cache_read: 0.025, output: 2 }) },
  { match: "minimax-m2.5", tiers: only({ input: 0.3, output: 1.2 }) },
  { match: /^text-embedding-3-small/, tiers: only({ input: 0.02, output: 0 }) },
  { match: "text-embedding-ada-002", tiers: only({ input: 0.1, output: 0 }) },
]

const ISO_DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/

const matchPricing = (publicName: string): ModelPricing | null => {
  for (const entry of COPILOT_MODEL_PRICING) {
    const hit =
      typeof entry.match === "string" ? publicName === entry.match : entry.match.test(publicName)
    if (hit) return entry.tiers[0]?.pricing ?? null
  }
  const dateless = publicName.replace(ISO_DATE_SUFFIX, "")
  if (dateless !== publicName) return matchPricing(dateless)
  return null
}

export const pricingForCopilotPublicModelId = (publicName: string): ModelPricing | null =>
  matchPricing(publicName)

export const pricingForCopilotModelKey = (modelKey: string): ModelPricing | null =>
  matchPricing(copilotPublicModelId(modelKey))

/** A catalog row: a model the docs page lists, with its tiers. */
export interface CopilotCatalogModel {
  readonly displayName: string
  readonly tiers: readonly PricingTier[]
}

export interface CopilotPricingCatalog {
  readonly source: typeof COPILOT_PRICING_SOURCE
  readonly models: readonly CopilotCatalogModel[]
}

/**
 * The subset of the table that mirrors the docs page: entries carrying a
 * `displayName`. Billing-only entries (legacy and internal models the page no
 * longer lists) are filtered out. Regex matchers are never exposed.
 */
export const copilotPricingCatalog = (): CopilotPricingCatalog => ({
  source: COPILOT_PRICING_SOURCE,
  models: COPILOT_MODEL_PRICING.filter(
    (m): m is CopilotModelPricing & { displayName: string } => Boolean(m.displayName),
  ).map((m) => ({ displayName: m.displayName, tiers: m.tiers })),
})
