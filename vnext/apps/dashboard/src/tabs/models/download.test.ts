import { describe, expect, it } from "bun:test"
import { imageFilename } from "./download"

const AT = new Date(Date.UTC(2026, 7, 22, 9, 5, 3))

describe("imageFilename", () => {
  it("stamps the time so saved images sort chronologically", () => {
    expect(imageFilename("data:image/png;base64,AAA", AT, 0)).toBe("playground-20260822-090503.png")
  })

  it("takes the extension from the data url's mime type", () => {
    expect(imageFilename("data:image/webp;base64,AAA", AT, 0)).toEndWith(".webp")
    expect(imageFilename("data:image/jpeg;base64,AAA", AT, 0)).toEndWith(".jpeg")
  })

  it("suffixes an index once a message holds more than one image", () => {
    expect(imageFilename("data:image/png;base64,AAA", AT, 1)).toBe("playground-20260822-090503-2.png")
    expect(imageFilename("data:image/png;base64,AAA", AT, 2)).toBe("playground-20260822-090503-3.png")
  })

  it("falls back to png for a url with no mime to read", () => {
    expect(imageFilename("https://example.com/a", AT, 0)).toBe("playground-20260822-090503.png")
  })

  it("keeps the extension of a remote url when it has one", () => {
    expect(imageFilename("https://example.com/a.webp", AT, 0)).toEndWith(".webp")
  })

  it("ignores a query string when reading a remote extension", () => {
    expect(imageFilename("https://example.com/a.jpg?v=2", AT, 0)).toEndWith(".jpg")
  })

  it("rejects an implausible extension rather than putting it in a filename", () => {
    expect(imageFilename("https://example.com/a.this-is-not-an-extension", AT, 0)).toEndWith(".png")
  })
})
