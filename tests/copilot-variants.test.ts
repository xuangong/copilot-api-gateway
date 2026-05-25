import { describe, expect, test } from "bun:test"

import type { Model, ModelsResponse } from "~/services/copilot/models"
import {
  buildCompositeModelId,
  composeModelOptions,
  copilotPublicModelId,
  filterAnthropicBetaForUpstream,
  hasContext1mBeta,
  mergeClaudeVariants,
  parseAnthropicBeta,
  parseCompositeModelId,
  resolveCopilotRawModel,
} from "~/services/copilot/variants"

const claudeVariant = (
  id: string,
  opts: {
    maxContext?: number
    maxPrompt?: number
    maxOutput?: number
    efforts?: string[]
  } = {},
): Model => ({
  id,
  name: id,
  object: "model",
  vendor: "anthropic",
  version: id,
  preview: false,
  model_picker_enabled: true,
  capabilities: {
    family: "claude",
    object: "model_capabilities",
    tokenizer: "claude",
    type: "chat",
    limits: {
      max_context_window_tokens: opts.maxContext,
      max_prompt_tokens: opts.maxPrompt,
      max_output_tokens: opts.maxOutput,
    },
    supports: {
      tool_calls: true,
      ...(opts.efforts ? { reasoning_effort: opts.efforts } : {}),
    } as Model["capabilities"]["supports"],
  },
})

describe("copilotPublicModelId", () => {
  test("strips known variant suffixes", () => {
    expect(copilotPublicModelId("claude-opus-4.7-high")).toBe("claude-opus-4.7")
    expect(copilotPublicModelId("claude-opus-4.7-xhigh")).toBe("claude-opus-4.7")
    expect(copilotPublicModelId("claude-opus-4.7-1m")).toBe("claude-opus-4.7")
    expect(copilotPublicModelId("claude-opus-4.7-1m-internal")).toBe("claude-opus-4.7")
  })

  test("strips dated suffix", () => {
    expect(copilotPublicModelId("claude-sonnet-4-20250514")).toBe("claude-sonnet-4")
  })

  test("non-claude ids pass through", () => {
    expect(copilotPublicModelId("gpt-5.5")).toBe("gpt-5.5")
  })
})

describe("mergeClaudeVariants", () => {
  test("merges high/xhigh/1m-internal into base", () => {
    const input: ModelsResponse = {
      object: "list",
      data: [
        claudeVariant("claude-opus-4.7", {
          maxContext: 200_000,
          efforts: ["low", "medium", "high"],
        }),
        claudeVariant("claude-opus-4.7-xhigh", { efforts: ["xhigh"] }),
        claudeVariant("claude-opus-4.7-1m-internal", {
          maxContext: 1_000_000,
          efforts: ["low", "medium", "high", "xhigh"],
        }),
      ],
    }
    const merged = mergeClaudeVariants(input)
    expect(merged.data).toHaveLength(1)
    const m = merged.data[0]!
    expect(m.id).toBe("claude-opus-4.7")
    expect(m.capabilities?.limits?.max_context_window_tokens).toBe(1_000_000)
    const efforts = (m.capabilities?.supports as { reasoning_effort?: string[] }).reasoning_effort
    expect(efforts?.sort()).toEqual(["high", "low", "medium", "xhigh"])
  })

  test("leaves non-claude untouched and preserves order", () => {
    const input: ModelsResponse = {
      object: "list",
      data: [
        claudeVariant("claude-opus-4.7-1m-internal"),
        claudeVariant("gpt-5.5"),
        claudeVariant("claude-opus-4.7"),
        claudeVariant("claude-sonnet-4.6"),
      ],
    }
    const merged = mergeClaudeVariants(input)
    expect(merged.data.map((m) => m.id)).toEqual([
      "claude-opus-4.7",
      "gpt-5.5",
      "claude-sonnet-4.6",
    ])
  })
})

describe("filterAnthropicBetaForUpstream", () => {
  test("drops context-1m-2025-08-07 and unknown betas", () => {
    expect(
      filterAnthropicBetaForUpstream([
        "context-1m-2025-08-07",
        "context-management-2025-06-27",
        "bogus-beta",
      ]),
    ).toEqual(["context-management-2025-06-27"])
  })

  test("injects interleaved-thinking when budget tokens set and not adaptive", () => {
    expect(
      filterAnthropicBetaForUpstream([], { thinkingBudgetTokens: true }),
    ).toEqual(["interleaved-thinking-2025-05-14"])
  })

  test("drops interleaved-thinking under adaptive thinking", () => {
    expect(
      filterAnthropicBetaForUpstream(["interleaved-thinking-2025-05-14"], {
        isAdaptiveThinking: true,
      }),
    ).toEqual([])
  })

  test("dedupes injected beta", () => {
    expect(
      filterAnthropicBetaForUpstream(["interleaved-thinking-2025-05-14"], {
        thinkingBudgetTokens: true,
      }),
    ).toEqual(["interleaved-thinking-2025-05-14"])
  })
})

describe("parseAnthropicBeta", () => {
  test("splits, trims, dedupes", () => {
    expect(parseAnthropicBeta(" a, b , a, c ")).toEqual(["a", "b", "c"])
  })
  test("empty/null returns []", () => {
    expect(parseAnthropicBeta(null)).toEqual([])
    expect(parseAnthropicBeta("")).toEqual([])
  })
})

describe("hasContext1mBeta", () => {
  test("detects flag", () => {
    expect(hasContext1mBeta(["context-1m-2025-08-07"])).toBe(true)
    expect(hasContext1mBeta(["other"])).toBe(false)
    expect(hasContext1mBeta(undefined)).toBe(false)
  })
})

describe("resolveCopilotRawModel", () => {
  const rawModels: ModelsResponse = {
    object: "list",
    data: [
      claudeVariant("claude-opus-4.7", {
        maxContext: 200_000,
        efforts: ["low", "medium", "high"],
      }),
      claudeVariant("claude-opus-4.7-xhigh", { efforts: ["xhigh"] }),
      claudeVariant("claude-opus-4.7-1m-internal", {
        maxContext: 1_000_000,
        efforts: ["low", "medium", "high", "xhigh"],
      }),
    ],
  }

  test("picks base when no hints", () => {
    expect(resolveCopilotRawModel(rawModels, "claude-opus-4.7")).toBe("claude-opus-4.7")
  })

  test("picks 1m-internal when context1m hint set", () => {
    expect(
      resolveCopilotRawModel(rawModels, "claude-opus-4.7", { context1m: true }),
    ).toBe("claude-opus-4.7-1m-internal")
  })

  test("picks xhigh variant for xhigh effort when no 1m variant supports it", () => {
    const noOneMXhigh: ModelsResponse = {
      object: "list",
      data: [
        claudeVariant("claude-opus-4.7", {
          maxContext: 200_000,
          efforts: ["low", "medium", "high"],
        }),
        claudeVariant("claude-opus-4.7-xhigh", { efforts: ["xhigh"] }),
        claudeVariant("claude-opus-4.7-1m-internal", {
          maxContext: 1_000_000,
          efforts: ["low", "medium", "high"],
        }),
      ],
    }
    expect(
      resolveCopilotRawModel(noOneMXhigh, "claude-opus-4.7", {
        reasoningEffort: "xhigh",
      }),
    ).toBe("claude-opus-4.7-xhigh")
  })

  test("prefers 1m variant when both effort and 1m can be satisfied", () => {
    expect(
      resolveCopilotRawModel(rawModels, "claude-opus-4.7", {
        reasoningEffort: "xhigh",
      }),
    ).toBe("claude-opus-4.7-1m-internal")
  })

  test("prefers 1m variant when both context1m and effort match", () => {
    expect(
      resolveCopilotRawModel(rawModels, "claude-opus-4.7", {
        context1m: true,
        reasoningEffort: "xhigh",
      }),
    ).toBe("claude-opus-4.7-1m-internal")
  })

  test("non-claude models pass through", () => {
    expect(resolveCopilotRawModel(rawModels, "gpt-5.5")).toBe("gpt-5.5")
  })

  test("normalizes dated/suffixed input", () => {
    expect(
      resolveCopilotRawModel(rawModels, "claude-opus-4.7-20250514"),
    ).toBe("claude-opus-4.7")
  })
})

describe("parseCompositeModelId", () => {
  test("plain base id", () => {
    expect(parseCompositeModelId("claude-opus-4.7")).toEqual({
      baseId: "claude-opus-4.7",
      effort: undefined,
      context1m: false,
    })
  })
  test("with effort suffix", () => {
    expect(parseCompositeModelId("claude-opus-4.7-high")).toEqual({
      baseId: "claude-opus-4.7",
      effort: "high",
      context1m: false,
    })
    expect(parseCompositeModelId("claude-opus-4.7-xhigh")).toEqual({
      baseId: "claude-opus-4.7",
      effort: "xhigh",
      context1m: false,
    })
  })
  test("with 1m suffix", () => {
    expect(parseCompositeModelId("claude-opus-4.7-1m")).toEqual({
      baseId: "claude-opus-4.7",
      effort: undefined,
      context1m: true,
    })
  })
  test("with both suffixes (effort first)", () => {
    expect(parseCompositeModelId("claude-opus-4.7-xhigh-1m")).toEqual({
      baseId: "claude-opus-4.7",
      effort: "xhigh",
      context1m: true,
    })
  })
  test("with both suffixes (1m first)", () => {
    expect(parseCompositeModelId("claude-opus-4.7-1m-xhigh")).toEqual({
      baseId: "claude-opus-4.7",
      effort: "xhigh",
      context1m: true,
    })
  })
  test("non-claude passes through", () => {
    expect(parseCompositeModelId("gpt-5.5")).toEqual({ baseId: "gpt-5.5" })
  })
})

describe("buildCompositeModelId", () => {
  test("round-trips composite ids", () => {
    expect(buildCompositeModelId("claude-opus-4.7")).toBe("claude-opus-4.7")
    expect(buildCompositeModelId("claude-opus-4.7", { effort: "xhigh" })).toBe(
      "claude-opus-4.7-xhigh",
    )
    expect(buildCompositeModelId("claude-opus-4.7", { context1m: true })).toBe(
      "claude-opus-4.7-1m",
    )
    expect(
      buildCompositeModelId("claude-opus-4.7", { effort: "xhigh", context1m: true }),
    ).toBe("claude-opus-4.7-xhigh-1m")
  })
  test("drops unknown effort suffix (low/medium are base)", () => {
    expect(buildCompositeModelId("claude-opus-4.7", { effort: "medium" })).toBe(
      "claude-opus-4.7",
    )
  })
})

describe("composeModelOptions", () => {
  const rawModels: ModelsResponse = {
    object: "list",
    data: [
      claudeVariant("claude-opus-4.7", {
        maxContext: 200_000,
        efforts: ["low", "medium", "high"],
      }),
      claudeVariant("claude-opus-4.7-xhigh", { efforts: ["xhigh"] }),
      claudeVariant("claude-opus-4.7-1m-internal", {
        maxContext: 1_000_000,
        efforts: ["low", "medium", "high", "xhigh"],
      }),
    ],
  }

  test("returns 200k and 1m buckets with effort union", () => {
    const combos = composeModelOptions(rawModels, "claude-opus-4.7")
    expect(combos).toEqual([
      { context1m: false, effort: "low" },
      { context1m: false, effort: "medium" },
      { context1m: false, effort: "high" },
      { context1m: false, effort: "xhigh" },
      { context1m: true, effort: "low" },
      { context1m: true, effort: "medium" },
      { context1m: true, effort: "high" },
      { context1m: true, effort: "xhigh" },
    ])
  })

  test("non-claude returns []", () => {
    expect(composeModelOptions(rawModels, "gpt-5.5")).toEqual([])
  })
})

describe("mergeClaudeVariants attaches available_combinations", () => {
  test("merged claude entry exposes (context, effort) matrix", () => {
    const merged = mergeClaudeVariants({
      object: "list",
      data: [
        claudeVariant("claude-opus-4.7", {
          maxContext: 200_000,
          efforts: ["low", "medium", "high"],
        }),
        claudeVariant("claude-opus-4.7-xhigh", { efforts: ["xhigh"] }),
        claudeVariant("claude-opus-4.7-1m-internal", {
          maxContext: 1_000_000,
          efforts: ["low", "medium", "high", "xhigh"],
        }),
      ],
    })
    const m = merged.data[0]!
    expect(m.available_combinations).toContainEqual({ context1m: false, effort: "xhigh" })
    expect(m.available_combinations).toContainEqual({ context1m: true, effort: "xhigh" })
    expect(m.available_combinations).toContainEqual({ context1m: false, effort: "low" })
  })
})
