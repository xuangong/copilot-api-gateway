/**
 * Per-public-model pricing table for the Codex (ChatGPT subscription) provider.
 * Codex bills as a flat-fee subscription rather than per-token, but we track
 * usage cost as if the operator were paying OpenAI's public API rates. Values
 * are USD per million tokens.
 *
 * vNext note: ported from copilot-gateway/packages/provider-codex/src/pricing.ts
 * but flattened to vNext's single-vector `ModelPricing` (see provider-copilot
 * pricing for the same pattern). The reference project's multi-vector
 * service-tier / long-context selectors are not modelled here; only the base
 * tier is kept. Re-introduce multi-vector pricing globally (not just for codex)
 * if/when needed.
 *
 * Sources and refresh procedure:
 * https://developers.openai.com/api/docs/pricing
 */

import type { ModelPricing } from '@vibe-llm/protocols/common'

type PricingRule = readonly [key: string | RegExp, pricing: ModelPricing]

const GPT_5_4_PRICING: ModelPricing = {
  input: 2.5, input_cache_read: 0.25, output: 15,
}

const CODEX_MODEL_PRICING: readonly PricingRule[] = [
  ['gpt-5.6-sol', {
    input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30,
  }],
  ['gpt-5.6-terra', {
    input: 2.5, input_cache_read: 0.25, input_cache_write: 3.125, output: 15,
  }],
  ['gpt-5.6-luna', {
    input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 6,
  }],
  ['gpt-5.5', {
    input: 5, input_cache_read: 0.5, output: 30,
  }],
  ['gpt-5.4', GPT_5_4_PRICING],
  ['gpt-5.4-mini', {
    input: 0.75, input_cache_read: 0.075, output: 4.5,
  }],
  ['codex-auto-review', GPT_5_4_PRICING],
]

export const pricingForCodexModelKey = (modelKey: string): ModelPricing | null => {
  for (const [key, pricing] of CODEX_MODEL_PRICING) {
    if (typeof key === 'string' ? modelKey === key : key.test(modelKey)) return pricing
  }
  return null
}
