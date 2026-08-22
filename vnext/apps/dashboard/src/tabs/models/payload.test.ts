import { describe, expect, it } from "bun:test"
import type { Part } from "./parts"
import { toAnthropicContent, toChatHistory, toGeminiParts, toOpenAIContent } from "./payload"

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

describe("assistant content", () => {
  // Image models put their output on the assistant turn. Chat APIs don't take
  // image blocks from the assistant, so replaying such a history as context
  // would 400 — drop the images and keep whatever text there was.
  it("drops images from an assistant turn", () => {
    expect(toOpenAIContent([text("here"), image(PNG)], "assistant")).toBe("here")
    expect(toAnthropicContent([text("here"), image(PNG)], "assistant")).toBe("here")
    expect(toGeminiParts([text("here"), image(PNG)], "assistant")).toEqual([{ text: "here" }])
  })

  it("keeps images on a user turn", () => {
    expect(toOpenAIContent([image(PNG)], "user")).toEqual([
      { type: "image_url", image_url: { url: PNG } },
    ])
  })

  it("keeps images when no role is given", () => {
    expect(toGeminiParts([image(PNG)])).toEqual([
      { inlineData: { mimeType: "image/png", data: "AAAA" } },
    ])
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

describe("toChatHistory", () => {
  const user = (text: string, parts?: Part[]) => ({ role: "user" as const, text, parts })
  const bot = (text: string, parts?: Part[]) => ({ role: "assistant" as const, text, parts })

  it("passes an ordinary conversation through unchanged", () => {
    expect(toChatHistory([user("hi"), bot("hello")])).toEqual([
      { role: "user", parts: [text("hi")] },
      { role: "assistant", parts: [text("hello")] },
    ])
  })

  // An image model writes its output on the assistant turn. No chat API takes
  // an image block from the assistant, but dropping it makes the picture
  // invisible to the next model — which is how a generated poster vanished
  // when the conversation moved to a chat model.
  it("moves an assistant's images onto the next user turn", () => {
    expect(toChatHistory([
      user("draw a poster", [text("draw a poster")]),
      bot("", [image(PNG)]),
      user("write copy for it", [text("write copy for it")]),
    ])).toEqual([
      { role: "user", parts: [text("draw a poster")] },
      { role: "user", parts: [image(PNG), text("write copy for it")] },
    ])
  })

  it("keeps the assistant's own words on the assistant turn", () => {
    expect(toChatHistory([
      bot("here you go", [text("here you go"), image(PNG)]),
      user("thanks"),
    ])).toEqual([
      { role: "assistant", parts: [text("here you go")] },
      { role: "user", parts: [image(PNG), text("thanks")] },
    ])
  })

  it("drops an assistant image with no later user turn to carry it", () => {
    expect(toChatHistory([user("draw"), bot("", [image(PNG)])])).toEqual([
      { role: "user", parts: [text("draw")] },
    ])
  })

  it("carries images across several assistant turns to the one user turn", () => {
    expect(toChatHistory([
      bot("", [image(PNG)]),
      bot("", [image(JPG)]),
      user("compare them"),
    ])).toEqual([
      { role: "user", parts: [image(PNG), image(JPG), text("compare them")] },
    ])
  })

  it("falls back to the flattened text when a message has no parts", () => {
    expect(toChatHistory([user("plain")])).toEqual([{ role: "user", parts: [text("plain")] }])
  })

  it("drops a message that has nothing left in it", () => {
    expect(toChatHistory([user(""), user("real")])).toEqual([
      { role: "user", parts: [text("real")] },
    ])
  })
})
