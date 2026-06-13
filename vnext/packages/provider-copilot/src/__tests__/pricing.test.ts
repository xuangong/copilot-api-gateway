import { test, expect } from "bun:test"
import { pricingForCopilotModelKey, pricingForCopilotPublicModelId } from "../pricing"

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
