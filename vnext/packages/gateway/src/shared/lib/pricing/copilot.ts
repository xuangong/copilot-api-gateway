/**
 * Per-model pricing table for Copilot upstream — vNext port of
 * src/pricing/copilot.ts. USD per million tokens.
 *
 * Source of truth:
 * https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 */
import type { ModelPricing } from '@vnext-llm/protocols/common'

type PricingRule = readonly [key: string | RegExp, pricing: ModelPricing]

const CLAUDE_VARIANT_SUFFIX = /-(?:high|xhigh|1m(?:-internal)?)$/
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/

export function copilotPublicModelId(id: string): string {
  const dateless = id.replace(DATE_SUFFIX, '')
  if (!dateless.startsWith('claude-')) return dateless
  return dateless
    .replace(/(?<=-)(\d+)-(\d+)(?=-|$)/g, '$1.$2')
    .replace(CLAUDE_VARIANT_SUFFIX, '')
    .replace(/(\d)\.(\d)/g, '$1-$2')
}

const COPILOT_MODEL_PRICING: readonly PricingRule[] = [
  [/^claude-opus-4-[5-8]$/, { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }],
  [/^claude-sonnet-4(-[56])?$/, { input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15 }],
  ['claude-haiku-4-5', { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 5 }],
  ['gpt-5.5', { input: 5, input_cache_read: 0.5, output: 30 }],
  ['gpt-5.4', { input: 2.5, input_cache_read: 0.25, output: 15 }],
  ['gpt-5.4-mini', { input: 0.75, input_cache_read: 0.075, output: 4.5 }],
  ['gpt-5.4-nano', { input: 0.2, input_cache_read: 0.02, output: 1.25 }],
  [/^gpt-5[.][23](-codex)?$/, { input: 1.75, input_cache_read: 0.175, output: 14 }],
  ['gpt-5.1-codex-mini', { input: 0.25, input_cache_read: 0.025, output: 2 }],
  [/^gpt-5[.]1/, { input: 1.25, input_cache_read: 0.125, output: 10 }],
  ['gpt-5-mini', { input: 0.25, input_cache_read: 0.025, output: 2 }],
  [/^gpt-4[.]1/, { input: 2, input_cache_read: 0.5, output: 8 }],
  ['gpt-41-copilot', { input: 2, input_cache_read: 0.5, output: 8 }],
  [/^gpt-4o(-[0-9]{4}-[0-9]{2}-[0-9]{2})?$/, { input: 2.5, input_cache_read: 1.25, output: 10 }],
  ['gpt-4-o-preview', { input: 2.5, input_cache_read: 1.25, output: 10 }],
  [/^gpt-4o-mini/, { input: 0.15, input_cache_read: 0.075, output: 0.6 }],
  [/^gpt-4(-0613)?$/, { input: 30, output: 60 }],
  ['gpt-4-0125-preview', { input: 10, output: 30 }],
  ['gpt-3.5-turbo', { input: 0.5, output: 1.5 }],
  ['gpt-3.5-turbo-0613', { input: 1.5, output: 2 }],
  ['gemini-2.5-pro', { input: 1.25, input_cache_read: 0.125, output: 10 }],
  ['gemini-3-flash-preview', { input: 0.5, input_cache_read: 0.05, output: 3 }],
  ['gemini-3.1-pro-preview', { input: 2, input_cache_read: 0.2, output: 12 }],
  ['gemini-3.5-flash', { input: 1.5, input_cache_read: 0.15, output: 9 }],
  [/^grok-code-fast/, { input: 0.2, output: 1.5 }],
  ['goldeneye', { input: 1.25, input_cache_read: 0.125, output: 10 }],
  ['raptor-mini', { input: 0.25, input_cache_read: 0.025, output: 2 }],
  ['minimax-m2.5', { input: 0.3, output: 1.2 }],
  [/^text-embedding-3-small/, { input: 0.02, output: 0 }],
  ['text-embedding-ada-002', { input: 0.1, output: 0 }],
]

function matchPricing(publicName: string): ModelPricing | null {
  for (const [key, pricing] of COPILOT_MODEL_PRICING) {
    if (typeof key === 'string' ? publicName === key : key.test(publicName)) return pricing
  }
  return null
}

export function pricingForCopilotPublicModelId(publicName: string): ModelPricing | null {
  return matchPricing(publicName)
}

export function pricingForCopilotModelKey(modelKey: string): ModelPricing | null {
  return matchPricing(copilotPublicModelId(modelKey))
}
