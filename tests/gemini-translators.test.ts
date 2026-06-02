import { test, expect, describe } from "bun:test"
import { translateGeminiToMessages } from "~/translators/gemini-via-messages/request"
import { translateGeminiToResponses } from "~/translators/gemini-via-responses/request"
import type { GeminiGenerateContentRequest } from "~/services/gemini/types"

describe("translateGeminiToMessages", () => {
  test("basic user text turn", () => {
    const req: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    }
    const out = translateGeminiToMessages(req, "gemini-2.5-pro")
    expect(out.model).toBe("gemini-2.5-pro")
    expect(out.messages.length).toBeGreaterThan(0)
    expect(out.max_tokens).toBeGreaterThan(0)
  })

  test("systemInstruction surfaces as Messages.system", () => {
    const req: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { role: "system", parts: [{ text: "be terse" }] },
    } as GeminiGenerateContentRequest
    const out = translateGeminiToMessages(req, "m")
    const systemText = Array.isArray(out.system)
      ? out.system.map((b) => b.text).join("")
      : (out.system ?? "")
    expect(systemText).toContain("be terse")
  })

  test("fallbackMaxOutputTokens carried through", () => {
    const out = translateGeminiToMessages(
      { contents: [{ role: "user", parts: [{ text: "x" }] }] },
      "m",
      { fallbackMaxOutputTokens: 9000 },
    )
    expect(out.max_tokens).toBe(9000)
  })
})

describe("translateGeminiToResponses", () => {
  test("basic turn produces Responses input items", () => {
    const out = translateGeminiToResponses(
      { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      "m",
    )
    expect(out.model).toBe("m")
    expect(Array.isArray(out.input)).toBe(true)
    expect(out.max_output_tokens).toBeGreaterThan(0)
  })
})

describe("Gemini thinkingConfig propagation", () => {
  test("thinkingBudget>0 → Messages thinking.budget_tokens", () => {
    const req: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "x" }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 4096 } },
    }
    const out = translateGeminiToMessages(req, "gemini-2.5-pro")
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 4096 })
  })

  test("thinkingLevel=minimal → Messages thinking budget=1024", () => {
    const req: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "x" }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
    }
    const out = translateGeminiToMessages(req, "gemini-3-pro")
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
  })

  test("thinkingBudget=0 → no thinking block", () => {
    const req: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "x" }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    }
    const out = translateGeminiToMessages(req, "gemini-2.5-pro")
    expect(out.thinking).toBeUndefined()
  })

  test("thinkingBudget=-1 (dynamic) → no thinking block (defer to upstream)", () => {
    const req: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "x" }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: -1 } },
    }
    const out = translateGeminiToMessages(req, "gemini-2.5-pro")
    expect(out.thinking).toBeUndefined()
  })

  test("thinkingConfig → Responses reasoning.effort", () => {
    const req: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "x" }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 10000 } },
    }
    const out = translateGeminiToResponses(req, "gpt-5-mini") as {
      reasoning?: { effort: string }
    }
    expect(out.reasoning?.effort).toBe("high")
  })
})
