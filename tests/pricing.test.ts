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
  test("matches claude sonnet 5 launch pricing", () => {
    const p = pricingForCopilotPublicModelId("claude-sonnet-5")
    expect(p).toEqual({ input: 2, cache_read: 0.2, cache_write: 2.5, output: 10 })
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
