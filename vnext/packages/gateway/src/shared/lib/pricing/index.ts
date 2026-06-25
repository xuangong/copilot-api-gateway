/**
 * Pricing module — vNext port of src/pricing/index.ts. Resolves per-token
 * USD cost from a recorded model id. Provider-scoped tables live alongside.
 */
import type { ModelPricing } from '@vibe-llm/protocols/common'
import { pricingForCopilotModelKey } from './copilot.ts'

export { pricingForCopilotModelKey, pricingForCopilotPublicModelId, copilotPublicModelId } from './copilot.ts'
export type { ModelPricing } from '@vibe-llm/protocols/common'

export interface CostBreakdown {
  inputUSD: number
  outputUSD: number
  cacheReadUSD: number
  cacheWriteUSD: number
  totalUSD: number
}

export function computeCost(
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  pricing: ModelPricing,
): CostBreakdown {
  const inputUSD = (tokens.input * (pricing.input ?? 0)) / 1_000_000
  const outputUSD = (tokens.output * (pricing.output ?? 0)) / 1_000_000
  const cacheReadUSD = pricing.input_cache_read != null
    ? ((tokens.cacheRead ?? 0) * pricing.input_cache_read) / 1_000_000
    : 0
  const cacheWriteUSD = pricing.input_cache_write != null
    ? ((tokens.cacheWrite ?? 0) * pricing.input_cache_write) / 1_000_000
    : 0
  return {
    inputUSD,
    outputUSD,
    cacheReadUSD,
    cacheWriteUSD,
    totalUSD: inputUSD + outputUSD + cacheReadUSD + cacheWriteUSD,
  }
}

export function resolvePricing(modelKey: string): ModelPricing | null {
  return pricingForCopilotModelKey(modelKey)
}

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
