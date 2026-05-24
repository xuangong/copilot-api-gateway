/**
 * Pricing module — public surface.
 *
 * Resolves per-token cost from a recorded model id. Provider-scoped tables
 * live under sibling files (`copilot.ts`); add custom/azure as needed.
 */

import type { ModelPricing } from "~/protocols/common"
import { pricingForCopilotModelKey } from "./copilot"

export { pricingForCopilotModelKey, pricingForCopilotPublicModelId, copilotPublicModelId } from "./copilot"

export type { ModelPricing } from "~/protocols/common"

export interface CostBreakdown {
  inputUSD: number
  outputUSD: number
  cacheReadUSD: number
  cacheWriteUSD: number
  totalUSD: number
}

/**
 * Compute USD cost from token counts and a pricing entry.
 * Pricing is per million tokens (sst/models.dev convention).
 */
export function computeCost(
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  pricing: ModelPricing,
): CostBreakdown {
  const inputUSD = (tokens.input * pricing.input) / 1_000_000
  const outputUSD = (tokens.output * pricing.output) / 1_000_000
  const cacheReadUSD = pricing.cache_read != null
    ? ((tokens.cacheRead ?? 0) * pricing.cache_read) / 1_000_000
    : 0
  const cacheWriteUSD = pricing.cache_write != null
    ? ((tokens.cacheWrite ?? 0) * pricing.cache_write) / 1_000_000
    : 0
  return {
    inputUSD,
    outputUSD,
    cacheReadUSD,
    cacheWriteUSD,
    totalUSD: inputUSD + outputUSD + cacheReadUSD + cacheWriteUSD,
  }
}

/**
 * Resolve pricing for a recorded model id. Currently routes everything to
 * the Copilot pricing table; extend per provider as additional upstreams
 * land (e.g. custom/azure).
 */
export function resolvePricing(modelKey: string): ModelPricing | null {
  return pricingForCopilotModelKey(modelKey)
}

/**
 * Convenience: cost from an existing usage record. Returns null if no
 * pricing entry matches the model.
 */
export function costForUsage(record: {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}): CostBreakdown | null {
  const pricing = resolvePricing(record.model)
  if (!pricing) return null
  return computeCost({
    input: record.inputTokens,
    output: record.outputTokens,
    cacheRead: record.cacheReadTokens,
    cacheWrite: record.cacheCreationTokens,
  }, pricing)
}
