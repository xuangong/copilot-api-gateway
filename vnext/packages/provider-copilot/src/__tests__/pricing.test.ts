import { test, expect } from "bun:test"
import { pricingForCopilotModelKey, pricingForCopilotPublicModelId, copilotPricingCatalog, COPILOT_PRICING_SOURCE, COPILOT_MODEL_PRICING } from "../pricing"

test("claude-opus-4-7 → 6-dim pricing with cache columns", () => {
  expect(pricingForCopilotPublicModelId("claude-opus-4-7")).toEqual({
    input: 5,
    input_cache_read: 0.5,
    input_cache_write: 6.25,
    output: 25,
  })
})

test("claude-sonnet-4-5 matches the variant-merged regex", () => {
  expect(pricingForCopilotPublicModelId("claude-sonnet-4-5")).toEqual({
    input: 3,
    input_cache_read: 0.3,
    input_cache_write: 3.75,
    output: 15,
  })
})

test("claude-sonnet-5 launch pricing (33% cheaper than sonnet-4.x)", () => {
  expect(pricingForCopilotPublicModelId("claude-sonnet-5")).toEqual({
    input: 2,
    input_cache_read: 0.2,
    input_cache_write: 2.5,
    output: 10,
  })
})

test("gpt-5.4 mini/nano differ from base 5.4", () => {
  expect(pricingForCopilotPublicModelId("gpt-5.4-mini")).toEqual({
    input: 0.75,
    input_cache_read: 0.075,
    output: 4.5,
  })
  expect(pricingForCopilotPublicModelId("gpt-5.4-nano")).toEqual({
    input: 0.2,
    input_cache_read: 0.02,
    output: 1.25,
  })
})

test("pricingForCopilotModelKey strips variant + date suffix", () => {
  expect(pricingForCopilotModelKey("claude-opus-4-7-xhigh")).toEqual({
    input: 5,
    input_cache_read: 0.5,
    input_cache_write: 6.25,
    output: 25,
  })
  expect(pricingForCopilotModelKey("claude-opus-4-5-20251101")).toEqual({
    input: 5,
    input_cache_read: 0.5,
    input_cache_write: 6.25,
    output: 25,
  })
})

test("unknown model returns null", () => {
  expect(pricingForCopilotModelKey("totally-made-up-model")).toBeNull()
  expect(pricingForCopilotPublicModelId("does-not-exist")).toBeNull()
})

// Live in a /models response (or in stored usage) but with no published rate.
// If one of these ever starts pricing, it was a deliberate decision, not drift.
test("models GitHub publishes no rate for stay unpriced", () => {
  for (const id of ["trajectory-compaction", "deepseek-v4-flash", "deepseek-v4-pro"]) {
    expect(pricingForCopilotPublicModelId(id)).toBeNull()
  }
})

test("embedding models map to input-only pricing", () => {  expect(pricingForCopilotPublicModelId("text-embedding-3-small")).toEqual({
    input: 0.02,
    output: 0,
  })
})

test("the default tier never carries a context threshold", () => {
  // A threshold on tiers[0] would make billing silently charge the
  // long-context rate for every request.
  for (const model of COPILOT_MODEL_PRICING) {
    expect(model.tiers[0]?.contextThreshold).toBeUndefined()
  }
})

test("every entry has at least one tier", () => {
  // Covers billing-only entries too: an empty `tiers` makes matchPricing
  // return null on a hit, silently zero-costing the model.
  for (const model of COPILOT_MODEL_PRICING) {
    expect(model.tiers.length).toBeGreaterThan(0)
  }
})

test("display names are unique so no two rows render identically", () => {
  const names = copilotPricingCatalog().models.map((m) => m.displayName)
  expect(new Set(names).size).toBe(names.length)
})

test("the catalog exposes only documented models", () => {
  expect(copilotPricingCatalog().models.length).toBeLessThan(COPILOT_MODEL_PRICING.length)
  for (const model of copilotPricingCatalog().models) {
    expect(model.displayName.length).toBeGreaterThan(0)
  }
})

test("the catalog carries its source url and verification date", () => {
  const { source } = copilotPricingCatalog()
  expect(source.url).toBe(COPILOT_PRICING_SOURCE.url)
  expect(source.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

function catalogRow(displayName: string) {
  const row = copilotPricingCatalog().models.find((m) => m.displayName === displayName)
  if (!row) throw new Error(`no catalog row for ${displayName}`)
  return row
}

test("GPT-5.5 carries both published bands", () => {
  const row = catalogRow("GPT-5.5")
  expect(row.tiers).toEqual([
    { label: "Default", pricing: { input: 5, input_cache_read: 0.5, output: 30 } },
    {
      label: "Long context",
      contextThreshold: 272_000,
      pricing: { input: 10, input_cache_read: 1, output: 45 },
    },
  ])
})

// Sol shipped priced byte-identically to GPT-5.5 — a copy/paste that billed it
// at 2.5x input and 3x output for five weeks. Pinning the real figures here.
test("GPT-5.6 Sol carries the 50%-off promo rate, not GPT-5.5's", () => {
  const row = catalogRow("GPT-5.6 Sol")
  expect(row.tiers).toEqual([
    {
      label: "Default",
      pricing: { input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 10 },
    },
    {
      label: "Long context",
      contextThreshold: 272_000,
      pricing: { input: 4, input_cache_read: 0.4, input_cache_write: 5, output: 15 },
    },
  ])
})

test("Sol Fast bills at exactly twice Sol and stays out of the catalog", () => {
  const sol = catalogRow("GPT-5.6 Sol").tiers
  const fast = COPILOT_MODEL_PRICING.find((m) => m.match === "gpt-5.6-sol-fast")
  if (!fast) throw new Error("no gpt-5.6-sol-fast entry")
  expect(fast.displayName).toBeUndefined()
  expect(fast.tiers.length).toBe(sol.length)
  for (const [i, tier] of fast.tiers.entries()) {
    const base = sol[i]!
    expect(tier.label).toBe(base.label)
    expect(tier.contextThreshold).toBe(base.contextThreshold)
    for (const [dim, rate] of Object.entries(tier.pricing)) {
      expect(rate).toBe((base.pricing[dim as keyof typeof base.pricing] as number) * 2)
    }
  }
})

test("GPT-5.6 Luna's long-context band starts at 200K, not 272K", () => {
  expect(catalogRow("GPT-5.6 Luna").tiers[1]).toEqual({
    label: "Long context",
    contextThreshold: 200_000,
    pricing: { input: 0.4, input_cache_read: 0.04, input_cache_write: 0.5, output: 1.8 },
  })
})

test("Grok 4.5 and Gemini 3.1 Pro also have long-context bands", () => {
  expect(catalogRow("Grok 4.5").tiers[1]).toEqual({
    label: "Long context",
    contextThreshold: 200_000,
    pricing: { input: 4, input_cache_read: 1, output: 12 },
  })
  expect(catalogRow("Gemini 3.1 Pro").tiers[1]).toEqual({
    label: "Long context",
    contextThreshold: 200_000,
    pricing: { input: 4, input_cache_read: 0.4, output: 18 },
  })
})

test("the merged claude matchers are split into one row per docs row", () => {
  const names = copilotPricingCatalog().models.map((m) => m.displayName)
  for (const n of [
    "Claude Opus 4.5",
    "Claude Opus 4.6",
    "Claude Opus 4.7",
    "Claude Opus 4.8",
    "Claude Sonnet 4",
    "Claude Sonnet 4.5",
    "Claude Sonnet 4.6",
  ]) {
    expect(names).toContain(n)
  }
})

test("splitting the claude matchers did not change what they price", () => {
  const opus = { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }
  for (const id of ["claude-opus-4-5", "claude-opus-4.6", "claude-opus-4-7", "claude-opus-4.8"]) {
    expect(pricingForCopilotPublicModelId(id)).toEqual(opus)
  }
  const sonnet = { input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15 }
  for (const id of ["claude-sonnet-4", "claude-sonnet-4-5", "claude-sonnet-4.6"]) {
    expect(pricingForCopilotPublicModelId(id)).toEqual(sonnet)
  }
})

test("MAI-Code-1.1-Flash is priced separately from MAI-Code-1-Flash", () => {
  expect(pricingForCopilotPublicModelId("mai-code-1.1-flash")).toEqual({
    input: 0.2,
    input_cache_read: 0.02,
    output: 1.2,
  })
  expect(pricingForCopilotPublicModelId("mai-code-1-flash")).toEqual({
    input: 0.75,
    input_cache_read: 0.075,
    output: 4.5,
  })
})

test("legacy and internal models stay out of the catalog", () => {
  const names = copilotPricingCatalog().models.map((m) => m.displayName)
  for (const n of ["goldeneye", "gpt-3.5-turbo", "gpt-4o", "minimax-m2.5"]) {
    expect(names).not.toContain(n)
  }
  // ...but they still price.
  expect(pricingForCopilotPublicModelId("goldeneye")).not.toBeNull()
  expect(pricingForCopilotPublicModelId("gpt-3.5-turbo")).not.toBeNull()
})

test("the catalog has one row per documented model", () => {
  // 11 Anthropic + 9 OpenAI + 4 Google + 2 xAI + 2 Microsoft + 2 Moonshot + 1 fine-tuned
  expect(copilotPricingCatalog().models.length).toBe(31)
})

test("both promo-priced Gemini flash rows share the promotional rate", () => {
  for (const id of ["gemini-3.6-flash", "gemini-3.7-flash"]) {
    expect(pricingForCopilotPublicModelId(id)).toEqual({
      input: 0.75,
      input_cache_read: 0.075,
      output: 3.75,
    })
  }
})

test("Grok 4.6 prices identically to 4.5, bands included", () => {
  expect(catalogRow("Grok 4.6").tiers).toEqual(catalogRow("Grok 4.5").tiers)
  expect(pricingForCopilotPublicModelId("grok-4.6")).toEqual({
    input: 2,
    input_cache_read: 0.5,
    output: 6,
  })
})
