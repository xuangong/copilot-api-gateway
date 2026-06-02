import { describe, expect, test } from "bun:test"

import {
  classifyChatCompletionsInitiator,
  classifyMessagesInitiator,
  classifyResponsesInitiator,
} from "~/transforms/set-initiator-header"
import type {
  AnthropicMessagesPayload,
  ResponsesPayload,
} from "~/transforms"

const msg = (messages: unknown[]): AnthropicMessagesPayload =>
  ({ model: "claude-sonnet-4-6", max_tokens: 10, messages }) as unknown as AnthropicMessagesPayload

describe("classifyMessagesInitiator", () => {
  test("empty / missing messages → user", () => {
    expect(classifyMessagesInitiator(msg([]))).toBe("user")
    expect(classifyMessagesInitiator({} as AnthropicMessagesPayload)).toBe("user")
  })

  test("assistant last → agent (count_tokens replay)", () => {
    expect(classifyMessagesInitiator(msg([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
    ]))).toBe("agent")
  })

  test("user with string content → user", () => {
    expect(classifyMessagesInitiator(msg([{ role: "user", content: "hello" }]))).toBe("user")
  })

  test("user with only tool_result blocks → agent", () => {
    expect(classifyMessagesInitiator(msg([
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ]))).toBe("agent")
  })

  test("user mixing text + tool_result → user", () => {
    expect(classifyMessagesInitiator(msg([
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
        { type: "text", text: "follow up" },
      ] },
    ]))).toBe("user")
  })
})

describe("classifyChatCompletionsInitiator", () => {
  test("empty → user", () => {
    expect(classifyChatCompletionsInitiator({ messages: [] })).toBe("user")
    expect(classifyChatCompletionsInitiator({})).toBe("user")
  })

  test("last role assistant → agent", () => {
    expect(classifyChatCompletionsInitiator({
      messages: [{ role: "user" }, { role: "assistant" }],
    })).toBe("agent")
  })

  test("last role tool → agent", () => {
    expect(classifyChatCompletionsInitiator({
      messages: [{ role: "assistant" }, { role: "tool" }],
    })).toBe("agent")
  })

  test("last role user → user", () => {
    expect(classifyChatCompletionsInitiator({
      messages: [{ role: "assistant" }, { role: "user" }],
    })).toBe("user")
  })

  test("last role system → user", () => {
    expect(classifyChatCompletionsInitiator({
      messages: [{ role: "system" }],
    })).toBe("user")
  })
})

const resp = (input: unknown): ResponsesPayload =>
  ({ model: "gpt-5", input }) as unknown as ResponsesPayload

describe("classifyResponsesInitiator", () => {
  test("empty / non-array input → user", () => {
    expect(classifyResponsesInitiator(resp([]))).toBe("user")
    expect(classifyResponsesInitiator(resp("hello"))).toBe("user")
  })

  test("last input item lacking role → agent (function_call_output)", () => {
    expect(classifyResponsesInitiator(resp([
      { type: "message", role: "user", content: "q" },
      { type: "function_call_output", call_id: "c1", output: "{}" },
    ]))).toBe("agent")
  })

  test("last item role=assistant → agent", () => {
    expect(classifyResponsesInitiator(resp([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]))).toBe("agent")
  })

  test("last item role=user → user", () => {
    expect(classifyResponsesInitiator(resp([
      { role: "assistant", content: "a" },
      { role: "user", content: "q2" },
    ]))).toBe("user")
  })

  test("role empty string → agent", () => {
    expect(classifyResponsesInitiator(resp([{ role: "" }]))).toBe("agent")
  })
})
