import { beforeEach, describe, expect, test } from "bun:test"
import {
  initImageProcessor,
  type ImageProcessor,
  type ImageSizeCalculator,
} from "~/image"
import { withInlineImagesCompressedResponses } from "~/providers/copilot/interceptors/responses/with-inline-images-compressed"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`
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
  endpoint: "responses",
  enabledFlags: new Set(enabled ? ["transform-compress-inline-images"] : []),
  payload: {
    model: "gpt-4o",
    input: hasImage
      ? [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: TINY_PNG_DATA_URL }],
          },
        ]
      : [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  },
  headers: {},
})

let spy: SpyProcessor

beforeEach(() => {
  spy = createSpyProcessor()
  initImageProcessor(spy)
})

describe("withInlineImagesCompressedResponses (responses)", () => {
  test("compresses inline image when flag enabled", async () => {
    const inv = makeInv(true, true)
    let runCalls = 0
    const result = await withInlineImagesCompressedResponses(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    expect(result).toBe(FAKE_RESPONSE)
    expect(spy.calls).toBe(1)
    expect(runCalls).toBe(1)
  })

  test("skips compression when flag disabled but still delegates", async () => {
    const inv = makeInv(false, true)
    let runCalls = 0
    const result = await withInlineImagesCompressedResponses(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    expect(result).toBe(FAKE_RESPONSE)
    expect(spy.calls).toBe(0)
    expect(runCalls).toBe(1)
  })

  test("no-op when payload has no images, still delegates", async () => {
    const inv = makeInv(true, false)
    let runCalls = 0
    const result = await withInlineImagesCompressedResponses(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    expect(result).toBe(FAKE_RESPONSE)
    expect(spy.calls).toBe(0)
    expect(runCalls).toBe(1)
  })

  test("propagates terminal response unchanged (no result mutation)", async () => {
    const inv = makeInv(true, true)
    const custom = new Response("custom-body", { status: 201 })
    const result = await withInlineImagesCompressedResponses(inv, ctx, async () => custom)
    expect(result).toBe(custom)
    expect(result.status).toBe(201)
  })
})
