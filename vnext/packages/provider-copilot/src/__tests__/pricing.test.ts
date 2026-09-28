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

test("the catalog excludes billing-only entries", () => {
  expect(copilotPricingCatalog().models.length).toBeLessThan(COPILOT_MODEL_PRICING.length)
  for (const model of copilotPricingCatalog().models) {
    expect(model.displayName.length).toBeGreaterThan(0)
  }
})

test("the dated public catalog contains exactly the models in the audited GitHub pricing table", () => {
  expect(copilotPricingCatalog().models.map((model) => model.displayName).sort()).toEqual([
    "Claude Fable 5", "Claude Fable 5.1", "Claude Haiku 4.5",
    "Claude Opus 4.7", "Claude Opus 4.8", "Claude Opus 4.8 (fast mode) (preview)",
    "Claude Opus 5", "Claude Opus 5.5", "Claude Sonnet 4", "Claude Sonnet 4.6", "Claude Sonnet 5",
    "GPT-5 mini", "GPT-5.3-Codex", "GPT-5.4", "GPT-5.4 mini", "GPT-5.4 nano",
    "GPT-5.5", "GPT-5.6 Luna", "GPT-5.6 Sol", "GPT-5.6 Terra",
    "GPT-6 Astra", "GPT-6 Luna", "GPT-6 Sol",
    "Gemini 3.5 Flash", "Gemini 3.6 Flash", "Gemini 3.7 Flash", "Gemini 3.8 Flash",
    "Grok 4.5", "Grok 4.6", "Grok 4.7",
    "Kimi K2.7 Code", "Kimi K3", "MAI-Code-1.1-Flash",
  ].sort())
})

test("historical and internal fallback rates remain available outside the dated catalog", () => {
  const cases = [
    ["claude-opus-4.5", { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }],
    ["claude-opus-4.6", { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }],
    ["claude-sonnet-4.5", { input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15 }],
    ["gpt-5.6-sol-fast", { input: 4, input_cache_read: 0.4, input_cache_write: 5, output: 20 }],
    ["gemini-3.1-pro-preview", { input: 2, input_cache_read: 0.2, output: 12 }],
    ["mai-code-1-flash", { input: 0.75, input_cache_read: 0.075, output: 4.5 }],
    ["raptor-mini", { input: 0.25, input_cache_read: 0.025, output: 2 }],
  ] as const
  for (const [modelId, expected] of cases) {
    expect(pricingForCopilotModelKey(modelId)).toEqual(expected)
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

test("GPT-6 Astra uses the documented default and long-context display bands", () => {
  const pricing = { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 50 }
  expect(catalogRow("GPT-6 Astra").tiers).toEqual([
    { label: "Default", pricing },
    { label: "Long context", contextThreshold: 272_000, pricing: { input: 20, input_cache_read: 2, input_cache_write: 25, output: 75 } },
  ])
  expect(pricingForCopilotPublicModelId("gpt-6-astra")).toEqual(pricing)
  expect(pricingForCopilotModelKey("gpt-6-astra")).toEqual(pricing)
  expect(pricingForCopilotModelKey("gpt-6-astra-2026-09-06")).toEqual(pricing)
})

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

test("GPT-5.6 Sol uses the post-promotion published rates", () => {
  const row = catalogRow("GPT-5.6 Sol")
  expect(row.tiers).toEqual([
    {
      label: "Default",
      pricing: { input: 4, input_cache_read: 0.4, input_cache_write: 5, output: 20 },
    },
    {
      label: "Long context",
      contextThreshold: 272_000,
      pricing: { input: 8, input_cache_read: 0.8, input_cache_write: 10, output: 30 },
    },
  ])
})

// The internal Sol Fast row has separate provenance from today's public Sol price.
test("Sol Fast's Default tier matches the published rates literally", () => {
  const fast = COPILOT_MODEL_PRICING.find((m) => m.match === "gpt-5.6-sol-fast")
  if (!fast) throw new Error("no gpt-5.6-sol-fast entry")
  expect(fast.tiers[0]).toEqual({
    label: "Default",
    pricing: { input: 4, input_cache_read: 0.4, input_cache_write: 5, output: 20 },
  })
})

test("Sol Fast's long-context band mirrors Sol's threshold", () => {
  // Only the threshold is asserted: the catalog shows a single 1M context
  // column with no band split, so the four rates in this tier are unverified
  // and pinning them here would dress a guess up as a fact.
  const fast = COPILOT_MODEL_PRICING.find((m) => m.match === "gpt-5.6-sol-fast")
  expect(fast?.tiers[1]?.contextThreshold).toBe(catalogRow("GPT-5.6 Sol").tiers[1]?.contextThreshold)
})

test("GPT-5.6 Luna's long-context band starts at 200K, not 272K", () => {
  expect(catalogRow("GPT-5.6 Luna").tiers[1]).toEqual({
    label: "Long context",
    contextThreshold: 200_000,
    pricing: { input: 0.4, input_cache_read: 0.04, input_cache_write: 0.5, output: 1.8 },
  })
})

test("Grok 4.5 public and Gemini 3.1 Pro historical fallback retain their long-context bands", () => {
  expect(catalogRow("Grok 4.5").tiers[1]).toEqual({
    label: "Long context",
    contextThreshold: 200_000,
    pricing: { input: 4, input_cache_read: 1, output: 12 },
  })
  const historicalGemini = COPILOT_MODEL_PRICING.find((model) => model.match === "gemini-3.1-pro-preview")
  expect(historicalGemini?.tiers[1]).toEqual({
    label: "Long context",
    contextThreshold: 200_000,
    pricing: { input: 4, input_cache_read: 0.4, output: 18 },
  })
})

test("the audited Claude rows are distinct in the public catalog", () => {
  const names = copilotPricingCatalog().models.map((m) => m.displayName)
  for (const n of [
    "Claude Opus 4.7",
    "Claude Opus 4.8",
    "Claude Sonnet 4",
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

test("the catalog includes each newly verified price row", () => {
  const names = copilotPricingCatalog().models.map((m) => m.displayName)
  for (const name of ["Claude Opus 5.5", "Claude Fable 5.1", "GPT-6 Sol", "GPT-6 Luna", "Gemini 3.8 Flash", "Grok 4.7"]) {
    expect(names).toContain(name)
  }
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

test("Opus 5.5 and Fable 5.1 retain their distinct cache rates through raw variants", () => {
  const opus5 = { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }
  const opus55 = { input: 4, input_cache_read: 0.2, input_cache_write: 5, output: 20 }
  const fable5 = { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 50 }
  const fable51 = { input: 10, input_cache_read: 0.25, input_cache_write: 12.5, output: 50 }
  expect(pricingForCopilotPublicModelId("claude-opus-5")).toEqual(opus5)
  expect(pricingForCopilotPublicModelId("claude-fable-5")).toEqual(fable5)
  for (const id of ["claude-opus-5.5", "claude-opus-5-5"]) expect(pricingForCopilotPublicModelId(id)).toEqual(opus55)
  for (const id of ["claude-fable-5.1", "claude-fable-5-1"]) expect(pricingForCopilotPublicModelId(id)).toEqual(fable51)
  expect(pricingForCopilotModelKey("claude-opus-5.5-xhigh")).toEqual(opus55)
  expect(pricingForCopilotModelKey("claude-fable-5.1-1m-internal")).toEqual(fable51)
  expect(pricingForCopilotModelKey("claude-opus-5.5-20260929")).toEqual(opus55)
})

test("new exact GPT lookup rows expose published bands while billing resolves the default", () => {
  const sol = { input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 10 }
  const luna = { input: 0.1, input_cache_read: 0.01, input_cache_write: 0.125, output: 0.5 }
  expect(catalogRow("GPT-6 Sol").tiers).toEqual([
    { label: "Default", pricing: sol },
    { label: "Long context", contextThreshold: 272_000, pricing: { input: 4, input_cache_read: 0.4, input_cache_write: 5, output: 15 } },
  ])
  expect(catalogRow("GPT-6 Luna").tiers).toEqual([
    { label: "Default", pricing: luna },
    { label: "Long context", contextThreshold: 272_000, pricing: { input: 0.2, input_cache_read: 0.02, input_cache_write: 0.25, output: 0.75 } },
  ])
  expect(pricingForCopilotModelKey("gpt-6-sol")).toEqual(sol)
  expect(pricingForCopilotModelKey("gpt-6-luna")).toEqual(luna)
})

test("new Gemini and Grok lookup rows use published promotional and long-context rates", () => {
  expect(pricingForCopilotModelKey("gemini-3.8-flash")).toEqual({ input: 0.75, input_cache_read: 0.075, output: 3.75 })
  expect(catalogRow("Grok 4.7").tiers).toEqual([
    { label: "Default", pricing: { input: 2, input_cache_read: 0.5, output: 6 } },
    { label: "Long context", contextThreshold: 200_000, pricing: { input: 4, input_cache_read: 1, output: 12 } },
  ])
  expect(pricingForCopilotModelKey("grok-4.7")).toEqual({ input: 2, input_cache_read: 0.5, output: 6 })
})

test("Opus 4.8 fast has an exact pricing lookup separate from the base model", () => {
  expect(pricingForCopilotModelKey("claude-opus-4.8-fast")).toEqual({ input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 50 })
  expect(pricingForCopilotModelKey("claude-opus-4.8")).toEqual({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 })
})

test("unpublished family versions and suffixes have no fallback price", () => {
  for (const id of ["claude-opus-5.9", "claude-fable-5.9", "grok-4.50", "kimi-k30", "gpt-6-sol-extra", "gpt-6-luna-fast", "gemini-3.8-flash-extra", "grok-4.7-preview"]) {
    expect(pricingForCopilotModelKey(id)).toBeNull()
  }
})
