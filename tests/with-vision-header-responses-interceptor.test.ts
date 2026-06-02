import { describe, expect, test } from "bun:test"
import { withResponsesVisionHeader } from "~/providers/copilot/interceptors/responses/with-vision-header"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const IMG_INPUT_ITEM = {
  type: "message",
  role: "user",
  content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
}

const TEXT_INPUT_ITEM = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "hello" }],
}

const makeInv = (enabled: boolean, withImage = true): Invocation => ({
  endpoint: "responses",
  enabledFlags: new Set(enabled ? ["transform-vision-header"] : []),
  payload: {
    model: "gpt-4o",
    input: withImage ? [IMG_INPUT_ITEM] : [TEXT_INPUT_ITEM],
  },
  headers: {},
})

describe("withResponsesVisionHeader", () => {
  test("sets copilot-vision-request when flag on and image present", async () => {
    const inv = makeInv(true)
    await withResponsesVisionHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["copilot-vision-request"]).toBe("true")
  })

  test("skips when flag off", async () => {
    const inv = makeInv(false)
    await withResponsesVisionHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect("copilot-vision-request" in inv.headers).toBe(false)
  })

  test("no header when flag on but no images in payload", async () => {
    const inv = makeInv(true, false)
    await withResponsesVisionHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect("copilot-vision-request" in inv.headers).toBe(false)
  })

  test("delegates terminal response unchanged", async () => {
    const inv = makeInv(true)
    const custom = new Response("custom-body", { status: 202 })
    const result = await withResponsesVisionHeader(inv, ctx, async () => custom)
    expect(result).toBe(custom)
    expect(result.status).toBe(202)
  })

  test("run is called exactly once", async () => {
    const inv = makeInv(true)
    let runCalls = 0
    await withResponsesVisionHeader(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    expect(runCalls).toBe(1)
  })
})
