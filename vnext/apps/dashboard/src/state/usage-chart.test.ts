import { describe, expect, test } from "bun:test"
import type { UsageRow } from "../api/usage"
import { buildUsageChartSeries, chartGrouping, DEFAULT_VISIBLE_MODELS, type UsageChartInput } from "./usage-chart"

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    hour: "2026-11-10T01",
    keyId: "key-a",
    incomingModel: "alias",
    model: "model-a",
    client: "client-a",
    requests: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheCreationTokens: 3,
    cost: { totalUSD: 0.5 },
    ...overrides,
  }
}

function input(rows: UsageRow[], overrides: Partial<UsageChartInput> = {}): UsageChartInput {
  return {
    rows,
    bucketKeys: ["2026-11-10T01", "2026-11-10T02"],
    bucketOf: (r) => r.hour,
    grouping: "model",
    modelKind: "routed",
    metric: "tokens",
    person: (r) => ({ id: `user:${r.keyId}`, label: r.keyId }),
    unknownLabel: "Unknown",
    ...overrides,
  }
}

describe("chartGrouping", () => {
  test("splits by person until an admin picks one, then by model", () => {
    expect(chartGrouping(true, "")).toBe("user")
    expect(chartGrouping(true, "user-a")).toBe("model")
  })

  test("a non-admin, who only ever sees their own usage, gets models", () => {
    expect(chartGrouping(false, "")).toBe("model")
  })
})

describe("buildUsageChartSeries", () => {
  test("one line per routed model, each bucket carrying value, cost and cache", () => {
    const lines = buildUsageChartSeries(input([
      row(),
      row({ hour: "2026-11-10T02", model: "model-b", cost: { totalUSD: 0.25 } }),
      row({ hour: "2026-11-10T02" }),
    ]))
    // 10 input + 5 output + 5 cache = 20 tokens per row.
    expect(lines).toEqual([
      { id: "model:model-a", label: "model-a", data: [20, 20], cost: [0.5, 0.5], cache: [5, 5], hidden: false },
      { id: "model:model-b", label: "model-b", data: [0, 20], cost: [0, 0.25], cache: [0, 5], hidden: false },
    ])
  })

  test("the incoming kind splits by the model the caller asked for", () => {
    const lines = buildUsageChartSeries(input([
      row({ incomingModel: "alias-x" }),
      row({ incomingModel: "alias-y" }),
    ], { modelKind: "incoming" }))
    expect(lines.map((l) => l.label).sort()).toEqual(["alias-x", "alias-y"])
  })

  test("a row with no model recorded is drawn under the unknown label", () => {
    const lines = buildUsageChartSeries(input([row({ model: undefined })]))
    expect(lines.map((l) => [l.id, l.label])).toEqual([["missing:", "Unknown"]])
  })

  test("models are ordered by total, and only the busiest few are shown at first", () => {
    const rows = Array.from({ length: DEFAULT_VISIBLE_MODELS + 2 }, (_, i) =>
      row({ model: `m${i}`, inputTokens: 10 * (i + 1), outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }))
    const lines = buildUsageChartSeries(input(rows))
    expect(lines.map((l) => l.label)).toEqual(["m7", "m6", "m5", "m4", "m3", "m2", "m1", "m0"])
    expect(lines.map((l) => l.hidden)).toEqual([false, false, false, false, false, false, true, true])
  })

  test("ties are broken by name so the order is stable", () => {
    const lines = buildUsageChartSeries(input([row({ model: "zeta" }), row({ model: "alpha" })]))
    expect(lines.map((l) => l.label)).toEqual(["alpha", "zeta"])
  })

  test("the requests metric counts requests and carries no cache", () => {
    const [line] = buildUsageChartSeries(input([row({ requests: 3 })], { metric: "requests" }))
    expect(line).toMatchObject({ data: [3, 0], cache: [0, 0], cost: [0.5, 0] })
  })

  test("per-person lines keep their first-seen order and all start visible", () => {
    const lines = buildUsageChartSeries(input([
      row({ keyId: "key-b" }),
      row({ keyId: "key-a", inputTokens: 1000 }),
    ], { grouping: "user" }))
    expect(lines).toEqual([
      { id: "user:key-b", label: "key-b", data: [20, 0], cost: [0.5, 0], cache: [5, 0], hidden: false },
      { id: "user:key-a", label: "key-a", data: [1010, 0], cost: [0.5, 0], cache: [5, 0], hidden: false },
    ])
  })

  test("rows outside the drawn buckets are ignored", () => {
    expect(buildUsageChartSeries(input([row({ hour: "2026-11-09T23" })]))).toEqual([])
  })
})
