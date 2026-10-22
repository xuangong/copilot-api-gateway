import { expect, test } from "bun:test"
import { lokiModelPricing } from "../pricing"
import { normalizeLokiModels } from "../models"

const fixtures = [
  { id: "claude-opus-5.5", raw: [0.00044, 0.0022, 0.000022, 0.00055], usd: [4.4, 22, 0.22, 5.5] },
  { id: "claude-opus-5", raw: [0.00055, 0.00275, 0.000055, 0.000688], usd: [5.5, 27.5, 0.55, 6.88] },
  { id: "claude-sonnet-5.5", raw: [0.00022, 0.0011, 0.000022, 0.000275], usd: [2.2, 11, 0.22, 2.75] },
  { id: "claude-sonnet-5", raw: [0.0002, 0.001, 0.00002, 0.00025], usd: [2, 10, 0.2, 2.5] },
  { id: "claude-haiku-5.5", raw: [0.000011, 0.000055, 0.0000011, 0.00001375], usd: [0.11, 0.55, 0.011, 0.1375] },
]
for (const { id, raw, usd } of fixtures) {
  test(`${id} retains Loki billing through normalization and JSON publication`, () => {
    const catalog = normalizeLokiModels({ data: [{ id, supported_endpoints: ["/v1/messages"], billing: {
      price_unit: "CopilotCredit", cost_per_input_token: raw[0], cost_per_output_token: raw[1],
      cache_read_cost_per_token: raw[2], cache_write_cost_per_token: raw[3],
    } }] })
    const restored = normalizeLokiModels(JSON.parse(JSON.stringify(catalog)))
    const pricing = lokiModelPricing(restored.data[0])
    expect(pricing?.input).toBeCloseTo(usd[0] ?? -1, 12)
    expect(pricing?.output).toBeCloseTo(usd[1] ?? -1, 12)
    expect(pricing?.input_cache_read).toBeCloseTo(usd[2] ?? -1, 12)
    expect(pricing?.input_cache_write).toBeCloseTo(usd[3] ?? -1, 12)
  })
}

test("missing or unknown billing units remain unpriced", () => {
  for (const billing of [undefined, null, {}, { price_unit: "USD", cost_per_input_token: 1 }, { cost_per_input_token: 1 }]) {
    expect(lokiModelPricing({ billing })).toBeNull()
  }
})

test("invalid values stay unknown, explicit zero stays free, partial prices stay partial", () => {
  for (const value of [-1, NaN, Infinity, -Infinity, Number.MAX_VALUE, "1", null, undefined]) {
    expect(lokiModelPricing({ billing: { price_unit: "CopilotCredit", cost_per_input_token: value } })).toBeNull()
  }
  expect(lokiModelPricing({ billing: { price_unit: "CopilotCredit", cost_per_input_token: 0,
    cost_per_output_token: -1, cache_read_cost_per_token: 0 } })).toEqual({ input: 0, input_cache_read: 0 })
  expect(lokiModelPricing({ billing: { price_unit: "CopilotCredit", cost_per_output_token: 0.0022 } })).toEqual({ output: 22 })
})
