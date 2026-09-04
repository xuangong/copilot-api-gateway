import { describe, expect, test } from "bun:test"
import type { UsageRow } from "../api/usage"
import type { ParticipantIndex } from "../tabs/usage/participants"
import {
  buildIncomingModelDistribution,
  buildRoutedModelDistribution,
  decodeIncomingModelOption,
  filterUsageRows,
  incomingModelFilterValue,
  incomingModelOptionValue,
  incomingModelSelectOptions,
  summarizeUsageRows,
  formatUsageFilterHint,
} from "./usage-model-dimensions"

const participants: ParticipantIndex = new Map([
  ["key-a", { keyId: "key-a", ownerId: "user-a", ownerName: "Ada", sharedWith: [] }],
  ["key-b", { keyId: "key-b", ownerId: "user-b", ownerName: "Bea", sharedWith: [] }],
])

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    hour: "2026-09-04T12",
    keyId: "key-a",
    model: "target-a",
    incomingModel: "alias-a",
    client: "client-a",
    requests: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheCreationTokens: 3,
    cost: { totalUSD: 0.1 },
    ...overrides,
  }
}

const allFilters = { user: "", key: "", client: "", model: "", incomingModel: null }

describe("incoming model select values", () => {
  test("round trips arbitrary JavaScript strings without colliding with control values", () => {
    for (const model of ["", "all", "legacy", "__all_incoming__", "model:caller-alias", "\ud800", "\udc00"]) {
      expect(() => incomingModelOptionValue(model)).not.toThrow()
      expect(decodeIncomingModelOption(incomingModelOptionValue(model))).toBe(model)
    }
    expect(decodeIncomingModelOption("all")).toBeNull()
    expect(decodeIncomingModelOption("legacy")).toBe("")
  })

  test("maps incoming filter state to its matching select option", () => {
    expect(incomingModelFilterValue(null)).toBe("all")
    expect(incomingModelFilterValue("")).toBe("legacy")
    expect(incomingModelFilterValue("all")).toBe("model:all")
    expect(incomingModelFilterValue("legacy")).toBe("model:legacy")
    expect(incomingModelFilterValue("model:caller-alias")).toBe("model:model:caller-alias")
  })

  test("lists legacy once and omits its duplicate encoded model option", () => {
    expect(
      incomingModelSelectOptions(["caller-b", "", "caller-a", "caller-a"], {
        all: "All",
        legacy: "Legacy",
      }),
    ).toEqual([
      { value: "all", label: "All" },
      { value: "legacy", label: "Legacy" },
      { value: "model:caller-a", label: "caller-a" },
      { value: "model:caller-b", label: "caller-b" },
    ])
  })
})

describe("usage filter hint", () => {
  test("formats routed and incoming model filters through translation callbacks", () => {
    const t = (key: string, vars?: Record<string, string | number>) => `${key}:${vars?.value ?? ""}:${vars?.selected ?? ""}:${vars?.remaining ?? ""}`
    expect(formatUsageFilterHint({ selected: ["dash.filterRoutedModel:target::", "dash.filterIncomingModel:caller::"], remaining: [] }, t))
      .toBe("dash.filterHintFiltered::dash.filterRoutedModel:target::, dash.filterIncomingModel:caller:::")
  })
})

describe("filterUsageRows", () => {
  const rows = [
    row(),
    row({ keyId: "key-b", model: "target-b", incomingModel: "alias-b", client: "client-b" }),
    row({ keyId: "key-a", model: "target-a", incomingModel: "" }),
  ]

  test("keeps every row when incoming model is All", () => {
    expect(filterUsageRows(rows, allFilters, participants)).toEqual(rows)
  })

  test("selects legacy unknown incoming model only", () => {
    expect(filterUsageRows(rows, { ...allFilters, incomingModel: "" }, participants)).toEqual([rows[2] as UsageRow])
  })

  test("combines incoming model with other dimensions using AND", () => {
    expect(
      filterUsageRows(rows, { ...allFilters, key: "key-a", client: "client-a", incomingModel: "alias-a" }, participants),
    ).toEqual([rows[0] as UsageRow])
  })

  test("returns filtered rows that are safe as chart input", () => {
    const chartRows = filterUsageRows(rows, { ...allFilters, incomingModel: "alias-b" }, participants)
    expect(chartRows.map((usage) => usage.model)).toEqual(["target-b"])
    expect(chartRows.reduce((total, usage) => total + usage.requests, 0)).toBe(1)
  })
})

describe("model distributions", () => {
  const rows = [
    row({ incomingModel: "alias-a", model: "target" }),
    row({ incomingModel: "alias-b", model: "target", requests: 2, inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheCreationTokens: 6, cost: { totalUSD: 0.2 } }),
    row({ incomingModel: "alias-a", model: "target-other", requests: 3, inputTokens: 30, outputTokens: 15, cacheReadTokens: 6, cacheCreationTokens: 9, cost: { totalUSD: 0.3 } }),
    row({ incomingModel: "", model: "target", requests: 4, inputTokens: 40, outputTokens: 20, cacheReadTokens: 8, cacheCreationTokens: 12, cost: { totalUSD: 0.4 } }),
  ]

  test("routed model distribution merges incoming aliases and conserves totals", () => {
    const distribution = buildRoutedModelDistribution(rows, "Unknown")
    expect(distribution).toMatchObject([
      { label: "target", requests: 7, input: 70, output: 35, cacheRead: 14, cacheCreation: 21 },
      { label: "target-other", requests: 3, input: 30, output: 15, cacheRead: 6, cacheCreation: 9 },
    ])
    expect(distribution.reduce((total, value) => total + value.costUSD, 0)).toBeCloseTo(1)
  })

  test("keeps a missing routed model separate from a real model named as its localized fallback", () => {
    const distribution = buildRoutedModelDistribution([
      row({ model: undefined, requests: 2 }),
      row({ model: "未知", requests: 3 }),
    ], "未知")

    expect(distribution.map((value) => value.requests).sort()).toEqual([2, 3])
    expect(distribution.every((value) => value.label === "未知")).toBe(true)
    expect(new Set(distribution.map((value) => value.id)).size).toBe(2)
    expect(summarizeUsageRows(distribution)).toEqual(summarizeUsageRows([
      row({ model: undefined, requests: 2 }),
      row({ model: "未知", requests: 3 }),
    ]))
  })

  test("keeps legacy and a real matching label in separate incoming groups", () => {
    const distribution = buildIncomingModelDistribution([
      row({ incomingModel: "", model: "legacy-target", requests: 2 }),
      row({ incomingModel: "Legacy / Unknown", model: "named-target", requests: 3 }),
    ], "Legacy / Unknown", "Unknown")

    expect(distribution).toMatchObject([
      { label: "Legacy / Unknown", requests: 2, routedModels: ["legacy-target"] },
      { label: "Legacy / Unknown", requests: 3, routedModels: ["named-target"] },
    ])
  })

  test("incoming distribution preserves legacy rows and lists each routed model once", () => {
    const distribution = buildIncomingModelDistribution(rows, "Legacy / Unknown", "Unknown")
    expect(distribution).toMatchObject([
      {
        label: "alias-a",
        requests: 4,
        input: 40,
        output: 20,
        cacheRead: 8,
        cacheCreation: 12,
        routedModels: ["target", "target-other"],
      },
      {
        label: "Legacy / Unknown",
        requests: 4,
        input: 40,
        output: 20,
        cacheRead: 8,
        cacheCreation: 12,
        routedModels: ["target"],
      },
      {
        label: "alias-b",
        requests: 2,
        input: 20,
        output: 10,
        cacheRead: 4,
        cacheCreation: 6,
        routedModels: ["target"],
      },
    ])
    expect(distribution.reduce((total, value) => total + value.costUSD, 0)).toBeCloseTo(1)
  })

  test("distribution totals and summary conserve every metric", () => {
    const summary = summarizeUsageRows(rows)
    for (const distribution of [
      buildRoutedModelDistribution(rows, "Unknown"),
      buildIncomingModelDistribution(rows, "Legacy / Unknown", "Unknown"),
    ]) {
      expect(summarizeUsageRows(distribution)).toEqual(summary)
    }
  })
})
