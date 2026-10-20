import { test, expect, describe } from "bun:test"
import {
  copilotPublicModelId,
  pricingForCopilotModelKey,
  pricingForCopilotPublicModelId,
  computeCost,
  costForUsage,
  resolvePricing,
} from "~/pricing"

describe("copilotPublicModelId", () => {
  test("strips claude variant suffix", () => {
    expect(copilotPublicModelId("claude-opus-4-7-xhigh")).toBe("claude-opus-4-7")
    expect(copilotPublicModelId("claude-sonnet-4-6-1m")).toBe("claude-sonnet-4-6")
    expect(copilotPublicModelId("claude-sonnet-4-5-1m-internal")).toBe("claude-sonnet-4-5")
  })
  test("strips claude date suffix", () => {
    expect(copilotPublicModelId("claude-opus-4-5-20251101")).toBe("claude-opus-4-5")
  })
  test("passes through non-claude ids untouched", () => {
    expect(copilotPublicModelId("gpt-5.4")).toBe("gpt-5.4")
    expect(copilotPublicModelId("gemini-2.5-pro")).toBe("gemini-2.5-pro")
  })
})

describe("pricing lookup", () => {
  test("matches claude opus variants via regex", () => {
    const p = pricingForCopilotPublicModelId("claude-opus-4-7")
    expect(p).toEqual({ input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 })
  })
  test("matches gpt-5.4-mini exact key", () => {
    const p = pricingForCopilotPublicModelId("gpt-5.4-mini")
    expect(p).toEqual({ input: 0.75, cache_read: 0.075, output: 4.5 })
  })
  test("strips variant suffix before matching", () => {
    expect(pricingForCopilotModelKey("claude-opus-4-7-xhigh")).toEqual({
      input: 5, cache_read: 0.5, cache_write: 6.25, output: 25,
    })
  })
  // GitHub Copilot models-and-pricing page, verified 2026-10-20.
  test.each([
    ["claude-opus-5", { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 }],
    ["claude-opus-5-5", { input: 4, cache_read: 0.2, cache_write: 5, output: 20 }],
    ["claude-sonnet-5", { input: 2, cache_read: 0.2, cache_write: 2.5, output: 10 }],
    ["claude-sonnet-5-5", { input: 2, cache_read: 0.1, cache_write: 2.5, output: 10 }],
    ["claude-haiku-5-5", { input: 0.1, cache_read: 0.01, cache_write: 0.125, output: 0.5 }],
  ])("prices Claude 5 family %s", (id, pricing) => {
    expect(pricingForCopilotPublicModelId(id)).toEqual(pricing)
  })
  test("prices Claude 5 family from raw Copilot ids", () => {
    expect(pricingForCopilotModelKey("claude-opus-5.5")).toEqual({
      input: 4, cache_read: 0.2, cache_write: 5, output: 20,
    })
    expect(pricingForCopilotModelKey("claude-sonnet-5.5-1m")).toEqual({
      input: 2, cache_read: 0.1, cache_write: 2.5, output: 10,
    })
    expect(pricingForCopilotModelKey("claude-opus-5-xhigh")).toEqual({
      input: 5, cache_read: 0.5, cache_write: 6.25, output: 25,
    })
    expect(pricingForCopilotModelKey("claude-haiku-5.5")).toEqual({
      input: 0.1, cache_read: 0.01, cache_write: 0.125, output: 0.5,
    })
  })
  // Default-tier rates mirrored from the vnext catalog; this table is single-tier.
  test.each([
    ["claude-opus-4.8-fast", { input: 10, cache_read: 1, cache_write: 12.5, output: 50 }],
    ["claude-fable-5", { input: 10, cache_read: 1, cache_write: 12.5, output: 50 }],
    ["claude-fable-5.1-1m", { input: 10, cache_read: 0.25, cache_write: 12.5, output: 50 }],
    ["gpt-6.1-sol", { input: 2, cache_read: 0.1, cache_write: 2.5, output: 10 }],
    ["gpt-6-astra-2026-09-06", { input: 10, cache_read: 1, cache_write: 12.5, output: 50 }],
    ["gpt-6-sol", { input: 2, cache_read: 0.2, cache_write: 2.5, output: 10 }],
    ["gpt-6-luna", { input: 0.1, cache_read: 0.01, cache_write: 0.125, output: 0.5 }],
    ["gpt-5.6-sol", { input: 4, cache_read: 0.4, cache_write: 5, output: 20 }],
    ["gpt-5.6-sol-fast", { input: 4, cache_read: 0.4, cache_write: 5, output: 20 }],
    ["gpt-5.6-terra", { input: 2, cache_read: 0.2, cache_write: 2.5, output: 12 }],
    ["gpt-5.6-luna", { input: 0.2, cache_read: 0.02, cache_write: 0.25, output: 1.2 }],
    ["gemini-3.6-flash", { input: 0.75, cache_read: 0.075, output: 3.75 }],
    ["gemini-3.7-flash", { input: 0.75, cache_read: 0.075, output: 3.75 }],
    ["gemini-3.8-flash", { input: 0.75, cache_read: 0.075, output: 3.75 }],
    ["gemini-4-argon", { input: 2, cache_read: 0.1, output: 10 }],
    ["grok-4.5", { input: 2, cache_read: 0.5, output: 6 }],
    ["grok-4.6", { input: 2, cache_read: 0.5, output: 6 }],
    ["grok-4.7", { input: 2, cache_read: 0.5, output: 6 }],
    ["mai-code-1.1-flash", { input: 0.2, cache_read: 0.02, output: 1.2 }],
    ["mai-code-1-flash", { input: 0.75, cache_read: 0.075, output: 4.5 }],
    ["kimi-k2.7-code", { input: 0.95, cache_read: 0.19, output: 4 }],
    ["kimi-k3", { input: 3, cache_read: 0.3, output: 15 }],
  ])("prices %s like the vnext catalog", (id, pricing) => {
    expect(pricingForCopilotModelKey(id)).toEqual(pricing)
  })
  test("unpublished ids stay unpriced", () => {
    for (const id of ["claude-haiku-5", "claude-opus-5-9", "gpt-6.1-sol-fast", "grok-4.50", "kimi-k30"]) {
      expect(pricingForCopilotModelKey(id)).toBeNull()
    }
  })
  test("returns null for unknown model", () => {
    expect(pricingForCopilotModelKey("model-that-does-not-exist")).toBeNull()
  })
})

describe("computeCost", () => {
  test("computes per-million-token cost", () => {
    const breakdown = computeCost(
      { input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheWrite: 100_000 },
      { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    )
    expect(breakdown.inputUSD).toBe(5)
    expect(breakdown.outputUSD).toBe(12.5)
    expect(breakdown.cacheReadUSD).toBe(0.1)
    expect(breakdown.cacheWriteUSD).toBe(0.625)
    expect(breakdown.totalUSD).toBeCloseTo(18.225, 6)
  })
  test("zero cache costs when pricing lacks cache fields", () => {
    const breakdown = computeCost(
      { input: 1_000_000, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      { input: 1, output: 1 },
    )
    expect(breakdown.cacheReadUSD).toBe(0)
    expect(breakdown.cacheWriteUSD).toBe(0)
  })
})

describe("costForUsage", () => {
  test("returns null when model has no pricing", () => {
    expect(costForUsage({
      model: "unknown-model", inputTokens: 100, outputTokens: 100,
    })).toBeNull()
  })
  test("computes from usage record", () => {
    const cost = costForUsage({
      model: "gpt-5.4-mini",
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 500_000,
    })
    expect(cost).not.toBeNull()
    expect(cost!.inputUSD).toBe(1.5)
    expect(cost!.outputUSD).toBe(4.5)
    expect(cost!.cacheReadUSD).toBeCloseTo(0.0375, 6)
  })
})

describe("resolvePricing", () => {
  test("resolves via copilot table", () => {
    expect(resolvePricing("gpt-5-mini")).toEqual({ input: 0.25, cache_read: 0.025, output: 2 })
  })
})
