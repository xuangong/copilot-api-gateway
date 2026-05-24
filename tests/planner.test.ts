import { test, expect, describe } from "bun:test"
import { pickTarget, preferenceOrder } from "~/providers/planner"

describe("pickTarget", () => {
  test("messages source prefers native messages", () => {
    expect(pickTarget("messages", ["messages", "chat_completions"])).toBe("messages")
  })
  test("messages source falls back to responses", () => {
    expect(pickTarget("messages", ["responses", "chat_completions"])).toBe("responses")
  })
  test("messages source falls back to chat_completions", () => {
    expect(pickTarget("messages", ["chat_completions"])).toBe("chat_completions")
  })
  test("responses source prefers native responses", () => {
    expect(pickTarget("responses", ["responses", "messages"])).toBe("responses")
  })
  test("responses source falls back to messages", () => {
    expect(pickTarget("responses", ["messages", "chat_completions"])).toBe("messages")
  })
  test("chat_completions source prefers native chat", () => {
    expect(pickTarget("chat_completions", ["chat_completions", "messages"])).toBe("chat_completions")
  })
  test("chat_completions source falls back to messages then responses", () => {
    expect(pickTarget("chat_completions", ["messages", "responses"])).toBe("messages")
    expect(pickTarget("chat_completions", ["responses"])).toBe("responses")
  })
  test("gemini source maps to chat_completions when available", () => {
    expect(pickTarget("gemini", ["chat_completions", "messages"])).toBe("chat_completions")
  })
  test("gemini source falls back to messages, then responses", () => {
    expect(pickTarget("gemini", ["messages", "responses"])).toBe("messages")
    expect(pickTarget("gemini", ["responses"])).toBe("responses")
  })
  test("returns null when no compatible endpoint", () => {
    expect(pickTarget("messages", ["embeddings"])).toBeNull()
    expect(pickTarget("messages", [])).toBeNull()
  })
  test("ignores non-generation endpoints", () => {
    expect(pickTarget("messages", ["messages_count_tokens", "embeddings"])).toBeNull()
  })
})

describe("preferenceOrder", () => {
  test("documented order per source", () => {
    expect(preferenceOrder("messages")).toEqual(["messages", "responses", "chat_completions"])
    expect(preferenceOrder("responses")).toEqual(["responses", "messages", "chat_completions"])
    expect(preferenceOrder("chat_completions")).toEqual(["chat_completions", "messages", "responses"])
    expect(preferenceOrder("gemini")).toEqual(["chat_completions", "messages", "responses"])
  })
})
