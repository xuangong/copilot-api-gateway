import { test, expect, describe } from "bun:test"
import {
  normalizeCountTokensRequest,
  translateGeminiCountTokensToAnthropic,
  totalTokensFromUpstream,
  type GeminiCountTokensRequest,
} from "~/services/gemini/count-tokens"

describe("normalizeCountTokensRequest", () => {
  test("prefers generateContentRequest when present", () => {
    const req: GeminiCountTokensRequest = {
      generateContentRequest: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      contents: [{ role: "user", parts: [{ text: "ignored" }] }],
    }
    expect(normalizeCountTokensRequest(req).contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
    ])
  })

  test("falls back to top-level contents", () => {
    const req: GeminiCountTokensRequest = {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    }
    const out = normalizeCountTokensRequest(req)
    expect(out.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }])
  })

  test("returns empty contents array when nothing provided", () => {
    expect(normalizeCountTokensRequest({}).contents).toEqual([])
  })
})

describe("translateGeminiCountTokensToAnthropic", () => {
  test("maps user/model roles and joins text parts", () => {
    const payload = translateGeminiCountTokensToAnthropic(
      {
        contents: [
          { role: "user", parts: [{ text: "hi " }, { text: "there" }] },
          { role: "model", parts: [{ text: "hello" }] },
        ],
      },
      "claude-3-5-sonnet",
    )
    expect(payload.model).toBe("claude-3-5-sonnet")
    expect(payload.messages).toEqual([
      { role: "user", content: "hi there" },
      { role: "assistant", content: "hello" },
    ])
  })

  test("includes systemInstruction as system text", () => {
    const payload = translateGeminiCountTokensToAnthropic(
      {
        contents: [{ role: "user", parts: [{ text: "q" }] }],
        systemInstruction: { parts: [{ text: "be brief" }] },
      },
      "claude-3-5-sonnet",
    )
    expect(payload.system).toBe("be brief")
  })

  test("always yields at least one user message", () => {
    const payload = translateGeminiCountTokensToAnthropic({ contents: [] }, "m")
    expect(payload.messages).toEqual([{ role: "user", content: "" }])
  })
})

describe("totalTokensFromUpstream", () => {
  test("reads input_tokens", () => {
    expect(totalTokensFromUpstream({ input_tokens: 42 })).toBe(42)
  })
  test("reads total_tokens as fallback", () => {
    expect(totalTokensFromUpstream({ total_tokens: 7 })).toBe(7)
  })
  test("returns null for malformed shapes", () => {
    expect(totalTokensFromUpstream(null)).toBe(null)
    expect(totalTokensFromUpstream({})).toBe(null)
    expect(totalTokensFromUpstream({ input_tokens: "x" })).toBe(null)
  })
})
