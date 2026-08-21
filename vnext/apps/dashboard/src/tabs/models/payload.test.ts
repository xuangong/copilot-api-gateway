import { describe, expect, it } from "bun:test"
import type { Part } from "./parts"
import { toAnthropicContent, toGeminiParts, toOpenAIContent } from "./payload"

const PNG = "data:image/png;base64,AAAA"
const JPG = "data:image/jpeg;base64,BBBB"
const REMOTE = "https://example.com/a.png"

const text = (s: string): Part => ({ type: "text", text: s })
const image = (dataUrl: string): Part => ({ type: "image", dataUrl })

describe("toOpenAIContent", () => {
  it("collapses a text-only message to a plain string", () => {
    expect(toOpenAIContent([text("hello")])).toBe("hello")
  })

  it("returns an empty string for an empty message", () => {
    expect(toOpenAIContent([])).toBe("")
  })

  it("emits ordered blocks with images inline", () => {
    expect(toOpenAIContent([text("a"), image(PNG), text("b")])).toEqual([
      { type: "text", text: "a" },
      { type: "image_url", image_url: { url: PNG } },
      { type: "text", text: "b" },
    ])
  })

  it("keeps consecutive images in order", () => {
    expect(toOpenAIContent([image(PNG), image(JPG)])).toEqual([
      { type: "image_url", image_url: { url: PNG } },
      { type: "image_url", image_url: { url: JPG } },
    ])
  })

  it("drops non-data-url images left over from persisted history", () => {
    expect(toOpenAIContent([text("a"), image(REMOTE)])).toBe("a")
  })
})

describe("toAnthropicContent", () => {
  it("collapses a text-only message to a plain string", () => {
    expect(toAnthropicContent([text("hello")])).toBe("hello")
  })

  // Regression: data URLs used to be sent as `source: { type: "url", url:
  // "data:..." }`, which a real Anthropic upstream rejects with a 400.
  it("sends a data url as a base64 source with its media_type", () => {
    expect(toAnthropicContent([image(PNG)])).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ])
  })

  it("emits ordered blocks with images inline", () => {
    expect(toAnthropicContent([text("a"), image(JPG), text("b")])).toEqual([
      { type: "text", text: "a" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
      { type: "text", text: "b" },
    ])
  })

  it("drops non-data-url images left over from persisted history", () => {
    expect(toAnthropicContent([text("a"), image(REMOTE)])).toBe("a")
  })
})

describe("toGeminiParts", () => {
  it("maps text parts to text entries", () => {
    expect(toGeminiParts([text("hello")])).toEqual([{ text: "hello" }])
  })

  it("maps data urls to inlineData in order", () => {
    expect(toGeminiParts([text("a"), image(PNG), text("b")])).toEqual([
      { text: "a" },
      { inlineData: { mimeType: "image/png", data: "AAAA" } },
      { text: "b" },
    ])
  })

  it("returns an empty array for an empty message", () => {
    expect(toGeminiParts([])).toEqual([])
  })

  it("drops non-data-url images left over from persisted history", () => {
    expect(toGeminiParts([text("a"), image(REMOTE)])).toEqual([{ text: "a" }])
  })
})
