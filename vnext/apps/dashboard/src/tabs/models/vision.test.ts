import { describe, expect, it } from "bun:test"
import { isImageRejection, VISION_OVERRIDES, visionSupport } from "./vision"

describe("visionSupport", () => {
  it("reports yes when the upstream claims vision", () => {
    expect(visionSupport("some-model", { vision: true })).toBe("yes")
  })

  it("reports no when the upstream lists capabilities without vision", () => {
    // Copilot omits the key rather than setting it false.
    expect(visionSupport("some-model", { tool_calls: true })).toBe("no")
  })

  it("reports unknown when the upstream publishes no capability list at all", () => {
    expect(visionSupport("some-model", undefined)).toBe("unknown")
  })

  it("prefers a measured override over a claim of no vision", () => {
    expect(visionSupport("gpt-4-o-preview", { tool_calls: true })).toBe("yes")
  })

  it("prefers a measured override over a claim of vision", () => {
    expect(visionSupport("gpt-4o", { vision: true })).toBe("yes-but-rejected")
  })

  it("applies an override even when the upstream published nothing", () => {
    expect(visionSupport("gpt-4", undefined)).toBe("yes")
  })

  it("leaves models outside the override table to their claim", () => {
    expect(VISION_OVERRIDES["claude-opus-5"]).toBeUndefined()
    expect(visionSupport("claude-opus-5", { vision: true })).toBe("yes")
  })
})

describe("isImageRejection", () => {
  it("matches the upstream's media-type refusal", () => {
    expect(isImageRejection('{"message":"validating image item: image media type not supported"}')).toBe(true)
  })

  it("matches the responses-flavoured refusal", () => {
    expect(isImageRejection("validating vision content in responses input: ...")).toBe(true)
  })

  it("ignores unrelated errors", () => {
    expect(isImageRejection("rate limit exceeded")).toBe(false)
  })

  it("ignores an empty message", () => {
    expect(isImageRejection("")).toBe(false)
  })
})
