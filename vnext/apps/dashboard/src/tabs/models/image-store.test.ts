import { describe, expect, it } from "bun:test"
import { hashDataUrl } from "./image-store"

const PNG = "data:image/png;base64,AAAA"

describe("hashDataUrl", () => {
  it("is stable for the same bytes", async () => {
    expect(await hashDataUrl(PNG)).toBe(await hashDataUrl(PNG))
  })

  it("differs for different bytes", async () => {
    expect(await hashDataUrl(PNG)).not.toBe(await hashDataUrl("data:image/png;base64,BBBB"))
  })

  it("is a short hex id", async () => {
    expect(await hashDataUrl(PNG)).toMatch(/^img_[0-9a-f]{32}$/)
  })
})
