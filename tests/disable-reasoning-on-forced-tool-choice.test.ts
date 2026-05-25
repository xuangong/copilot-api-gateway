/**
 * Tests for disable-reasoning-on-forced-tool-choice transform.
 *
 * Borrowed-in-spirit from Menci/copilot-gateway interceptor tests across
 * three target protocols.
 */

import { describe, expect, test } from "bun:test"

import {
  disableChatCompletionsReasoningOnForcedToolChoice,
  disableMessagesReasoningOnForcedToolChoice,
  disableResponsesReasoningOnForcedToolChoice,
} from "~/transforms/disable-reasoning-on-forced-tool-choice"
import type { AnthropicMessagesPayload, ResponsesPayload } from "~/transforms"

const ON = new Set(["disable-reasoning-on-forced-tool-choice"])
const OFF = new Set<string>()

describe("disable-reasoning-on-forced-tool-choice: Messages", () => {
  test("no-op when flag is off", () => {
    const payload = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
      tool_choice: { type: "tool", name: "search" },
    } as unknown as AnthropicMessagesPayload
    expect(disableMessagesReasoningOnForcedToolChoice(payload, OFF)).toBe(false)
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 4096 } as never)
  })

  test("no-op when tool_choice is not forced", () => {
    const payload = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
      tool_choice: { type: "auto" },
    } as unknown as AnthropicMessagesPayload
    expect(disableMessagesReasoningOnForcedToolChoice(payload, ON)).toBe(false)
  })

  test("disables thinking when tool_choice is 'tool'", () => {
    const payload = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
      output_config: { effort: "high" },
      tool_choice: { type: "tool", name: "search" },
    } as unknown as AnthropicMessagesPayload
    expect(disableMessagesReasoningOnForcedToolChoice(payload, ON)).toBe(true)
    expect(payload.thinking).toEqual({ type: "disabled" } as never)
    expect((payload as unknown as { output_config?: unknown }).output_config).toBeUndefined()
  })

  test("disables thinking when tool_choice is 'any'", () => {
    const payload = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
      tool_choice: { type: "any" },
    } as unknown as AnthropicMessagesPayload
    expect(disableMessagesReasoningOnForcedToolChoice(payload, ON)).toBe(true)
    expect(payload.thinking).toEqual({ type: "disabled" } as never)
  })
})

describe("disable-reasoning-on-forced-tool-choice: Responses", () => {
  test("strips reasoning when tool_choice is required (string)", () => {
    const payload = {
      model: "gpt-5",
      input: [],
      reasoning: { effort: "high" },
      tool_choice: "required",
    } as unknown as ResponsesPayload
    expect(disableResponsesReasoningOnForcedToolChoice(payload, ON)).toBe(true)
    expect((payload as unknown as { reasoning?: unknown }).reasoning).toBeUndefined()
  })

  test("strips reasoning when tool_choice is object", () => {
    const payload = {
      model: "gpt-5",
      input: [],
      reasoning: { effort: "medium" },
      tool_choice: { type: "function", name: "search" },
    } as unknown as ResponsesPayload
    expect(disableResponsesReasoningOnForcedToolChoice(payload, ON)).toBe(true)
    expect((payload as unknown as { reasoning?: unknown }).reasoning).toBeUndefined()
  })

  test("no-op when tool_choice is 'auto'", () => {
    const payload = {
      model: "gpt-5",
      input: [],
      reasoning: { effort: "high" },
      tool_choice: "auto",
    } as unknown as ResponsesPayload
    expect(disableResponsesReasoningOnForcedToolChoice(payload, ON)).toBe(false)
    expect((payload as unknown as { reasoning?: unknown }).reasoning).toEqual({
      effort: "high",
    } as never)
  })

  test("vendor-deepseek adds thinking:disabled", () => {
    const payload = {
      model: "deepseek-chat",
      input: [],
      reasoning: { effort: "high" },
      tool_choice: "required",
    } as unknown as ResponsesPayload
    const flags = new Set([
      "disable-reasoning-on-forced-tool-choice",
      "vendor-deepseek",
    ])
    expect(disableResponsesReasoningOnForcedToolChoice(payload, flags)).toBe(true)
    expect((payload as unknown as { thinking?: unknown }).thinking).toEqual({
      type: "disabled",
    } as never)
  })

  test("vendor-qwen adds enable_thinking:false", () => {
    const payload = {
      model: "qwen-plus",
      input: [],
      reasoning: { effort: "high" },
      tool_choice: "required",
    } as unknown as ResponsesPayload
    const flags = new Set([
      "disable-reasoning-on-forced-tool-choice",
      "vendor-qwen",
    ])
    expect(disableResponsesReasoningOnForcedToolChoice(payload, flags)).toBe(true)
    expect((payload as unknown as { enable_thinking?: boolean }).enable_thinking).toBe(false)
  })
})

describe("disable-reasoning-on-forced-tool-choice: Chat Completions", () => {
  test("strips reasoning_effort when tool_choice is required (string)", () => {
    const payload = {
      model: "gpt-4",
      messages: [],
      reasoning_effort: "high" as const,
      tool_choice: "required",
    }
    expect(disableChatCompletionsReasoningOnForcedToolChoice(payload, ON)).toBe(true)
    expect(payload.reasoning_effort).toBeUndefined()
  })

  test("no-op when tool_choice is 'auto'", () => {
    const payload = {
      model: "gpt-4",
      messages: [],
      reasoning_effort: "high" as const,
      tool_choice: "auto",
    }
    expect(disableChatCompletionsReasoningOnForcedToolChoice(payload, ON)).toBe(false)
    expect(payload.reasoning_effort).toBe("high")
  })

  test("vendor-deepseek adds thinking:disabled", () => {
    const payload = {
      model: "deepseek-chat",
      messages: [],
      reasoning_effort: "high" as const,
      tool_choice: { type: "function", function: { name: "search" } },
    } as Parameters<typeof disableChatCompletionsReasoningOnForcedToolChoice>[0]
    const flags = new Set([
      "disable-reasoning-on-forced-tool-choice",
      "vendor-deepseek",
    ])
    expect(disableChatCompletionsReasoningOnForcedToolChoice(payload, flags)).toBe(true)
    expect(payload.thinking).toEqual({ type: "disabled" })
  })
})
