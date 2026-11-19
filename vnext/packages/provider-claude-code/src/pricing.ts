// Per-public-model pricing for the Claude Code (Claude.ai subscription)
// provider. Values are notional USD per million tokens at Anthropic's public
// API rates, so an operator can compare subscription value with direct spend.
// https://docs.claude.com/en/docs/about-claude/pricing
//
// vNext note: ported from copilot-gateway/packages/provider-claude-code/src/pricing.ts
// but flattened to vNext's single-vector `ModelPricing` (see provider-codex
// pricing for the same pattern). The reference project's multi-vector
// service-tier `fastPricing` (6× on Opus 4.6/4.7, 2× from Opus 4.8+) is NOT
// modelled here — only the base tier is kept. Re-introduce multi-vector
// pricing globally (not just for claude-code) if/when needed.
//
// Prompt-cache ratios at the base tier: input × 0.1 (read), × 1.25 (5-minute
// write). The 1-hour write rate (× 2) is dropped since vNext has a single
// `input_cache_write` slot.

import type { ModelPricing } from '@vibe-llm/protocols/common'

const OPUS_PRICING: ModelPricing = {
  input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25,
}

const SONNET_PRICING: ModelPricing = {
  input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15,
}

// Sonnet 5 introductory pricing runs through 2026-08-31.
const SONNET_5_INTRO_PRICING: ModelPricing = {
  input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 10,
}

const HAIKU_PRICING: ModelPricing = {
  input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 5,
}

const FABLE_5_PRICING: ModelPricing = {
  input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 50,
}

// Sonnet 5.5 cuts cache reads to $0.10; kept separate from Sonnet 5 so a change
// to either card cannot silently alter the other.
// https://platform.claude.com/docs/en/models/sonnet-5-5/overview
const SONNET_5_5_PRICING: ModelPricing = {
  input: 2, input_cache_read: 0.1, input_cache_write: 2.5, output: 10,
}

// Haiku 5.5 base tier. The reference also prices a whole request at
// $0.5/$0.05/$0.625/$2.5 when input exceeds 100,000 tokens; ModelPricing here
// is a single vector, so that long-context tier is not modelled.
// https://platform.claude.com/docs/en/models/haiku-5-5/overview
// https://github.com/anomalyco/models.dev/blob/bde18f10ee3da7d5eb4cc07bfd3d374a93a8f025/providers/anthropic/models/claude-haiku-5-5.toml
const HAIKU_5_5_PRICING: ModelPricing = {
  input: 0.1, input_cache_read: 0.01, input_cache_write: 0.125, output: 0.5,
}

// Fable 5.1 keeps Fable 5's base rates while cutting cache reads to 0.025x.
// https://platform.claude.com/docs/en/models/fable-5-1/overview
// https://platform.claude.com/docs/en/about-claude/pricing
// https://github.com/anomalyco/models.dev/blob/bf06cd2a3ae2922acd435ddc441ca5874f93ee8a/providers/anthropic/models/claude-fable-5-1.toml
const FABLE_5_1_PRICING: ModelPricing = {
  input: 10, input_cache_read: 0.25, input_cache_write: 12.5, output: 50,
}

const OPUS_4_1_PRICING: ModelPricing = {
  input: 15, input_cache_read: 1.5, input_cache_write: 18.75, output: 75,
}

const CLAUDE_CODE_MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': OPUS_PRICING,
  'claude-opus-4-8': OPUS_PRICING,
  'claude-opus-4-7': OPUS_PRICING,
  'claude-opus-4-6': OPUS_PRICING,
  // https://support.claude.com/en/articles/11940350-claude-code-model-configuration
  'claude-sonnet-5-5': SONNET_5_5_PRICING,
  'claude-sonnet-5': SONNET_5_INTRO_PRICING,
  'claude-haiku-5-5': HAIKU_5_5_PRICING,
  'claude-fable-5-1': FABLE_5_1_PRICING,
  'claude-sonnet-4-6': SONNET_PRICING,
  'claude-fable-5': FABLE_5_PRICING,
  'claude-sonnet-4-5-20250929': SONNET_PRICING,
  'claude-opus-4-5-20251101': OPUS_PRICING,
  'claude-haiku-4-5-20251001': HAIKU_PRICING,
  'claude-opus-4-1-20250805': OPUS_4_1_PRICING,
}

export const pricingForClaudeCodeModelKey = (modelKey: string): ModelPricing | null =>
  CLAUDE_CODE_MODEL_PRICING[modelKey] ?? null
