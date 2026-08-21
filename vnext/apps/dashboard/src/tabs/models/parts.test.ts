import { describe, expect, it } from "bun:test"
import { type ComposerNode, domToParts, partsToText, splitDataUrl } from "./parts"

// Node factories mirroring the structural subset `domToParts` walks. Real DOM
// nodes satisfy `ComposerNode` structurally, so these literals exercise the
// same code path the browser does without pulling in a DOM implementation.
const text = (s: string): ComposerNode => ({ nodeType: 3, nodeName: "#text", textContent: s })

const el = (
  nodeName: string,
  childNodes: ComposerNode[] = [],
  attrs: Record<string, string> = {},
): ComposerNode => ({
  nodeType: 1,
  nodeName,
  childNodes,
  getAttribute: (n: string) => attrs[n] ?? null,
})

const img = (src: string) => el("IMG", [], { src })
const storedImg = (src: string, id: string) => el("IMG", [], { src, "data-img-id": id })
const br = () => el("BR")
const root = (children: ComposerNode[]) => el("DIV", children)

const PNG = "data:image/png;base64,AAAA"
const JPG = "data:image/jpeg;base64,BBBB"

describe("domToParts", () => {
  it("returns a single text part for plain text", () => {
    expect(domToParts(root([text("hello")]))).toEqual([{ type: "text", text: "hello" }])
  })

  it("preserves text → image → text order", () => {
    const parts = domToParts(root([text("before "), img(PNG), text(" after")]))
    expect(parts).toEqual([
      { type: "text", text: "before " },
      { type: "image", dataUrl: PNG },
      { type: "text", text: " after" },
    ])
  })

  it("keeps consecutive images as separate adjacent parts", () => {
    expect(domToParts(root([img(PNG), img(JPG)]))).toEqual([
      { type: "image", dataUrl: PNG },
      { type: "image", dataUrl: JPG },
    ])
  })

  it("turns <br> into a newline inside the surrounding text", () => {
    expect(domToParts(root([text("a"), br(), text("b")]))).toEqual([
      { type: "text", text: "a\nb" },
    ])
  })

  it("treats a block-level child as a line break", () => {
    expect(domToParts(root([text("a"), el("DIV", [text("b")])]))).toEqual([
      { type: "text", text: "a\nb" },
    ])
  })

  it("does not emit a leading newline for the first block child", () => {
    expect(domToParts(root([el("DIV", [text("a")]), el("DIV", [text("b")])]))).toEqual([
      { type: "text", text: "a\nb" },
    ])
  })

  it("flattens inline wrappers pasted from rich text", () => {
    expect(domToParts(root([el("SPAN", [text("a"), el("B", [text("b")])])]))).toEqual([
      { type: "text", text: "ab" },
    ])
  })

  it("returns an empty array for an empty composer", () => {
    expect(domToParts(root([]))).toEqual([])
  })

  it("returns an empty array for whitespace-only content", () => {
    expect(domToParts(root([text("  \n ")]))).toEqual([])
  })

  it("trims leading and trailing whitespace around the whole message", () => {
    expect(domToParts(root([text("  hi  ")]))).toEqual([{ type: "text", text: "hi" }])
  })

  it("keeps interior spacing next to an image", () => {
    expect(domToParts(root([text("  a "), img(PNG), text(" b  ")]))).toEqual([
      { type: "text", text: "a " },
      { type: "image", dataUrl: PNG },
      { type: "text", text: " b" },
    ])
  })

  it("drops whitespace-only text between two images", () => {
    expect(domToParts(root([img(PNG), br(), img(JPG)]))).toEqual([
      { type: "image", dataUrl: PNG },
      { type: "image", dataUrl: JPG },
    ])
  })

  it("ignores an image without a src", () => {
    expect(domToParts(root([text("a"), el("IMG")]))).toEqual([{ type: "text", text: "a" }])
  })

  it("carries the stored image id when the element has one", () => {
    expect(domToParts(root([storedImg(PNG, "img_abc")]))).toEqual([
      { type: "image", dataUrl: PNG, id: "img_abc" },
    ])
  })

  it("ignores comment nodes", () => {
    const comment: ComposerNode = { nodeType: 8, nodeName: "#comment", textContent: "x" }
    expect(domToParts(root([text("a"), comment]))).toEqual([{ type: "text", text: "a" }])
  })
})

describe("partsToText", () => {
  it("concatenates text parts and skips images", () => {
    expect(
      partsToText([
        { type: "text", text: "a" },
        { type: "image", dataUrl: PNG },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab")
  })

  it("returns an empty string for an image-only message", () => {
    expect(partsToText([{ type: "image", dataUrl: PNG }])).toBe("")
  })
})

describe("splitDataUrl", () => {
  it("splits mime and base64 body", () => {
    expect(splitDataUrl("data:image/png;base64,AAAA")).toEqual({ mime: "image/png", data: "AAAA" })
  })

  it("ignores parameters after the mime type", () => {
    expect(splitDataUrl("data:image/jpeg;charset=utf-8;base64,BB")).toEqual({
      mime: "image/jpeg",
      data: "BB",
    })
  })

  it("returns null for a remote url", () => {
    expect(splitDataUrl("https://example.com/a.png")).toBeNull()
  })

  it("returns null for a malformed data url", () => {
    expect(splitDataUrl("data:image/png;base64")).toBeNull()
  })
})
