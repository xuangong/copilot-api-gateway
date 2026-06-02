import { test, expect, describe } from "bun:test"

import {
  setChatCompletionsVisionHeader,
  setMessagesVisionHeader,
  setResponsesVisionHeader,
} from "~/transforms/set-vision-header"
import type { AnthropicMessagesPayload, ResponsesPayload } from "~/transforms/types"

const msg = (content: unknown): AnthropicMessagesPayload =>
  ({
    model: "claude-test",
    max_tokens: 10,
    messages: [{ role: "user", content }],
  }) as unknown as AnthropicMessagesPayload

const IMG = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "AAAA" },
}

describe("setMessagesVisionHeader", () => {
  test("sets header for top-level image block", () => {
    const h: Record<string, string> = {}
    expect(setMessagesVisionHeader(msg([IMG, { type: "text", text: "hi" }]), h)).toBe(true)
    expect(h["copilot-vision-request"]).toBe("true")
  })

  test("sets header for image nested in tool_result.content", () => {
    const h: Record<string, string> = {}
    setMessagesVisionHeader(
      msg([{ type: "tool_result", tool_use_id: "x", content: [IMG] }]),
      h,
    )
    expect(h["copilot-vision-request"]).toBe("true")
  })

  test("absent for text-only payloads", () => {
    const h: Record<string, string> = {}
    expect(setMessagesVisionHeader(msg([{ type: "text", text: "hi" }]), h)).toBe(false)
    expect("copilot-vision-request" in h).toBe(false)
  })

  test("absent for string content", () => {
    const h: Record<string, string> = {}
    setMessagesVisionHeader(msg("hi"), h)
    expect("copilot-vision-request" in h).toBe(false)
  })
})

describe("setChatCompletionsVisionHeader", () => {
  test("sets header for image_url part", () => {
    const h: Record<string, string> = {}
    const payload = {
      messages: [
        { role: "user", content: [
          { type: "text", text: "what's this?" },
          { type: "image_url", image_url: { url: "https://x/y.png" } },
        ] },
      ],
    }
    expect(setChatCompletionsVisionHeader(payload, h)).toBe(true)
    expect(h["copilot-vision-request"]).toBe("true")
  })

  test("absent for pure text", () => {
    const h: Record<string, string> = {}
    setChatCompletionsVisionHeader(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      h,
    )
    expect("copilot-vision-request" in h).toBe(false)
  })

  test("absent for string content", () => {
    const h: Record<string, string> = {}
    setChatCompletionsVisionHeader({ messages: [{ role: "user", content: "hi" }] }, h)
    expect("copilot-vision-request" in h).toBe(false)
  })
})

describe("setResponsesVisionHeader", () => {
  test("sets header for top-level input_image in message", () => {
    const h: Record<string, string> = {}
    const payload = {
      model: "gpt-5",
      input: [
        { type: "message", role: "user", content: [
          { type: "input_text", text: "hi" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ] },
      ],
    } as unknown as ResponsesPayload
    expect(setResponsesVisionHeader(payload, h)).toBe(true)
    expect(h["copilot-vision-request"]).toBe("true")
  })

  test("recurses into nested content (tool output)", () => {
    const h: Record<string, string> = {}
    const payload = {
      model: "gpt-5",
      input: [
        { type: "custom_tool_call_output", content: [
          { type: "output_text", text: "shot" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ] },
      ],
    } as unknown as ResponsesPayload
    setResponsesVisionHeader(payload, h)
    expect(h["copilot-vision-request"]).toBe("true")
  })

  test("matches legacy `image` type", () => {
    const h: Record<string, string> = {}
    const payload = {
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: [{ type: "image", image_url: "x" }] }],
    } as unknown as ResponsesPayload
    setResponsesVisionHeader(payload, h)
    expect(h["copilot-vision-request"]).toBe("true")
  })

  test("absent for pure text input", () => {
    const h: Record<string, string> = {}
    const payload = {
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    } as unknown as ResponsesPayload
    expect(setResponsesVisionHeader(payload, h)).toBe(false)
    expect("copilot-vision-request" in h).toBe(false)
  })

  test("absent for string input (short-circuit)", () => {
    const h: Record<string, string> = {}
    const payload = { model: "gpt-5", input: "hello" } as unknown as ResponsesPayload
    expect(setResponsesVisionHeader(payload, h)).toBe(false)
    expect("copilot-vision-request" in h).toBe(false)
  })
})
