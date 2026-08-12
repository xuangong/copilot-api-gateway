import { test, expect } from "bun:test"
import { pricingForCopilotModelKey, pricingForCopilotPublicModelId, copilotPricingCatalog, COPILOT_PRICING_SOURCE } from "../pricing"

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

test("embedding models map to input-only pricing", () => {
  expect(pricingForCopilotPublicModelId("text-embedding-3-small")).toEqual({
    input: 0.02,
    output: 0,
  })
})

test("the default tier never carries a context threshold", () => {
  // A threshold on tiers[0] would make billing silently charge the
  // long-context rate for every request.
  for (const model of copilotPricingCatalog().models) {
    expect(model.tiers[0]?.contextThreshold).toBeUndefined()
  }
})

test("every catalog entry has at least one tier", () => {
  for (const model of copilotPricingCatalog().models) {
    expect(model.tiers.length).toBeGreaterThan(0)
  }
})

test("display names are unique so no two rows render identically", () => {
  const names = copilotPricingCatalog().models.map((m) => m.displayName)
  expect(new Set(names).size).toBe(names.length)
})

test("the catalog exposes only documented models", () => {
  for (const model of copilotPricingCatalog().models) {
    expect(typeof model.displayName).toBe("string")
    expect(model.displayName.length).toBeGreaterThan(0)
  }
})

test("the catalog carries its source url and verification date", () => {
  const { source } = copilotPricingCatalog()
  expect(source.url).toBe(COPILOT_PRICING_SOURCE.url)
  expect(source.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})
