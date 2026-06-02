import { describe, expect, test } from "bun:test"

import {
  anthropicContextWindowErrorBody,
  isContextWindowError,
} from "~/transforms/rewrite-context-window-error"

describe("isContextWindowError", () => {
  test("detects Vertex/Gemini-style message", () => {
    expect(isContextWindowError(JSON.stringify({
      error: { message: "Request body is too large for model context window" },
    }))).toBe(true)
  })

  test("detects OpenAI-style code", () => {
    expect(isContextWindowError(JSON.stringify({
      error: { code: "context_length_exceeded", message: "too many tokens" },
    }))).toBe(true)
  })

  test("returns false for unrelated errors", () => {
    expect(isContextWindowError(JSON.stringify({
      error: { message: "internal server error" },
    }))).toBe(false)
    expect(isContextWindowError("")).toBe(false)
  })
})

describe("anthropicContextWindowErrorBody", () => {
  test("returns Anthropic invalid_request_error shape with canonical prompt", () => {
    const parsed = JSON.parse(anthropicContextWindowErrorBody()) as {
      type: string
      error: { type: string; message: string }
    }
    expect(parsed.type).toBe("error")
    expect(parsed.error.type).toBe("invalid_request_error")
    // Claude Code matches on the "prompt is too long" prefix to trigger compaction
    expect(parsed.error.message.startsWith("prompt is too long")).toBe(true)
  })
})
