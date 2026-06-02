import { beforeEach, describe, expect, test } from "bun:test"
import {
  initImageProcessor,
  type ImageProcessor,
  type ImageSizeCalculator,
} from "~/image"
import { withInlineImagesCompressed } from "~/providers/copilot/interceptors/messages/with-inline-images-compressed"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const FAKE_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46])

interface SpyProcessor extends ImageProcessor {
  calls: number
}
const createSpyProcessor = (): SpyProcessor => {
  const spy = {
    calls: 0,
    compressToWebp(_b: Uint8Array, _t: ImageSizeCalculator) {
      spy.calls++
      return Promise.resolve(FAKE_WEBP)
    },
  }
  return spy
}

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const makeInv = (enabled: boolean, hasImage: boolean): Invocation => ({
  endpoint: "messages",
  enabledFlags: new Set(enabled ? ["transform-compress-inline-images"] : []),
  payload: {
    model: "claude-opus-4.7",
    messages: hasImage ? [{
      role: "user",
      content: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 },
      }],
    }] : [],
  },
  headers: {},
})

let spy: SpyProcessor

beforeEach(() => {
  spy = createSpyProcessor()
  initImageProcessor(spy)
})

describe("withInlineImagesCompressed (messages)", () => {
  test("compresses inline image when flag enabled", async () => {
    const inv = makeInv(true, true)
    const result = await withInlineImagesCompressed(inv, ctx, async () => FAKE_RESPONSE)
    expect(result).toBe(FAKE_RESPONSE)
    expect(spy.calls).toBe(1)
  })

  test("skips compression when flag disabled but still delegates", async () => {
    const inv = makeInv(false, true)
    const result = await withInlineImagesCompressed(inv, ctx, async () => FAKE_RESPONSE)
    expect(result).toBe(FAKE_RESPONSE)
    expect(spy.calls).toBe(0)
  })

  test("no-op when payload has no images, still delegates", async () => {
    const inv = makeInv(true, false)
    const result = await withInlineImagesCompressed(inv, ctx, async () => FAKE_RESPONSE)
    expect(result).toBe(FAKE_RESPONSE)
    expect(spy.calls).toBe(0)
  })

  test("propagates terminal response unchanged (no result mutation)", async () => {
    const inv = makeInv(true, true)
    const custom = new Response("custom-body", { status: 201 })
    const result = await withInlineImagesCompressed(inv, ctx, async () => custom)
    expect(result).toBe(custom)
    expect(result.status).toBe(201)
  })
})
