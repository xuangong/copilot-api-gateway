import type { BillingDimension, ModelPricing } from "@vibe-llm/protocols/common"

// Loki reports credits per token; the gateway stores USD per million tokens.
// https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
const USD_PER_MILLION_PER_CREDIT = 0.01 * 1_000_000
const fields = {
  cost_per_input_token: "input",
  cost_per_output_token: "output",
  cache_read_cost_per_token: "input_cache_read",
  cache_write_cost_per_token: "input_cache_write",
} as const satisfies Record<string, BillingDimension>

type LokiBilling = { price_unit: "CopilotCredit" } & Partial<Record<keyof typeof fields, number>>
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function normalizeLokiBilling(value: unknown): LokiBilling | undefined {
  const source = record(value)
  if (source.price_unit !== "CopilotCredit") return undefined
  const result: LokiBilling = { price_unit: "CopilotCredit" }
  for (const field of Object.keys(fields) as Array<keyof typeof fields>) {
    const rate = source[field]
    if (typeof rate === "number" && rate >= 0 && Number.isFinite(rate * USD_PER_MILLION_PER_CREDIT)) result[field] = rate
  }
  return result
}

export function lokiModelPricing(model: unknown): ModelPricing | null {
  const billing = normalizeLokiBilling(record(model).billing)
  if (!billing) return null
  const pricing: ModelPricing = {}
  for (const field of Object.keys(fields) as Array<keyof typeof fields>) {
    const rate = billing[field]
    if (rate !== undefined) pricing[fields[field]] = rate * USD_PER_MILLION_PER_CREDIT
  }
  return Object.keys(pricing).length ? pricing : null
}
