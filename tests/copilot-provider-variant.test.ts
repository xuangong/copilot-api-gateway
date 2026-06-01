import { describe, expect, mock, test, beforeEach } from "bun:test"

import type { Model, ModelsResponse } from "~/services/copilot/models"

type ForwardCall = {
  endpoint: string
  payload: Record<string, unknown>
  extraHeaders?: Record<string, string>
}

const calls: ForwardCall[] = []

const claudeVariant = (
  id: string,
  opts: { maxContext?: number; efforts?: string[] } = {},
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
    limits: { max_context_window_tokens: opts.maxContext },
    supports: {
      tool_calls: true,
      ...(opts.efforts ? { reasoning_effort: opts.efforts } : {}),
    } as Model["capabilities"]["supports"],
  },
})

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
    claudeVariant("claude-sonnet-4.6", {
      maxContext: 200_000,
      efforts: ["low", "medium", "high"],
    }),
  ],
}

mock.module("~/services/copilot/raw-models-cache", () => ({
  getCachedRawModels: async () => rawModels,
}))

mock.module("~/services/copilot/forward", () => ({
  callCopilotAPI: async (args: ForwardCall) => {
    calls.push({
      endpoint: args.endpoint,
      payload: { ...args.payload },
      extraHeaders: args.extraHeaders ? { ...args.extraHeaders } : undefined,
    })
    return new Response("{}")
  },
}))

const { CopilotProvider } = await import("~/providers/copilot/provider")

function provider(): InstanceType<typeof CopilotProvider> {
  return new CopilotProvider({ copilotToken: "token", accountType: "individual" })
}

beforeEach(() => {
  calls.length = 0
})

describe("CopilotProvider Claude variant resolution", () => {
  test("messages payload effort selects the matching raw model", async () => {
    await provider().callMessages({
      model: "claude-opus-4.7",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      output_config: { effort: "xhigh" },
    })

    expect(calls[0]?.payload.model).toBe("claude-opus-4.7-1m-internal")
    expect(calls[0]?.payload.output_config).toEqual({ effort: "xhigh" })
  })

  test("chat completions payload effort selects the matching raw model", async () => {
    await provider().fetch(
      "chat_completions",
      { method: "POST", body: JSON.stringify({
        model: "claude-opus-4.7",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "xhigh",
      }) },
    )

    expect(calls[0]?.payload.model).toBe("claude-opus-4.7-1m-internal")
    expect(calls[0]?.payload.reasoning_effort).toBe("xhigh")
  })

  test("responses payload effort selects the matching raw model", async () => {
    await provider().callResponses({
      model: "claude-opus-4.7",
      input: "hi",
      reasoning: { effort: "xhigh" },
    })

    expect(calls[0]?.payload.model).toBe("claude-opus-4.7-1m-internal")
    expect(calls[0]?.payload.reasoning).toEqual({ effort: "xhigh" })
  })

  test("composite model suffix beats header and payload effort", async () => {
    await provider().callMessages(
      {
        model: "claude-opus-4.7-xhigh-1m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        output_config: { effort: "low" },
      },
      { extraHeaders: { "x-copilot-reasoning-effort": "high" } },
    )

    expect(calls[0]?.payload.model).toBe("claude-opus-4.7-1m-internal")
    expect(calls[0]?.payload.output_config).toEqual({ effort: "xhigh" })
    expect(calls[0]?.extraHeaders?.["x-copilot-reasoning-effort"]).toBeUndefined()
  })

  test("payload effort beats custom header effort", async () => {
    await provider().callMessages(
      {
        model: "claude-opus-4.7",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        output_config: { effort: "xhigh" },
      },
      { extraHeaders: { "x-copilot-reasoning-effort": "high" } },
    )

    expect(calls[0]?.payload.model).toBe("claude-opus-4.7-1m-internal")
    expect(calls[0]?.payload.output_config).toEqual({ effort: "xhigh" })
    expect(calls[0]?.extraHeaders?.["x-copilot-reasoning-effort"]).toBeUndefined()
  })

  test("non-Claude model ignores Copilot Claude variant hints", async () => {
    await provider().fetch(
      "chat_completions",
      { method: "POST", body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "xhigh",
      }) },
      { extraHeaders: { "anthropic-beta": "context-1m-2025-08-07" } },
    )

    expect(calls[0]?.payload.model).toBe("gpt-5.5")
    expect(calls[0]?.payload.reasoning_effort).toBe("xhigh")
  })
})
