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
    expect(typeof out.system === "string" ? out.system : "").toContain("be terse")
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
