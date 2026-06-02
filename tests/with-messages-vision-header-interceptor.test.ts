import { describe, expect, test } from "bun:test"
import { withMessagesVisionHeader } from "~/providers/copilot/interceptors/messages/with-vision-header"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const IMG_BLOCK = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "AAAA" },
}

const makeInv = (enabled: boolean, withImage = true): Invocation => ({
  endpoint: "messages",
  enabledFlags: new Set(enabled ? ["transform-vision-header"] : []),
  payload: {
    model: "claude-sonnet-4-6",
    messages: withImage
      ? [{ role: "user", content: [IMG_BLOCK, { type: "text", text: "what is this?" }] }]
      : [{ role: "user", content: "hi" }],
  },
  headers: {},
})

describe("withMessagesVisionHeader", () => {
  test("sets copilot-vision-request when flag on and image present", async () => {
    const inv = makeInv(true)
    await withMessagesVisionHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["copilot-vision-request"]).toBe("true")
  })

  test("skips when flag off", async () => {
    const inv = makeInv(false)
    await withMessagesVisionHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect("copilot-vision-request" in inv.headers).toBe(false)
  })

  test("no header when flag on but no images in payload", async () => {
    const inv = makeInv(true, false)
    await withMessagesVisionHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect("copilot-vision-request" in inv.headers).toBe(false)
  })

  test("delegates terminal response unchanged", async () => {
    const custom = new Response("c", { status: 202 })
    const result = await withMessagesVisionHeader(makeInv(true), ctx, async () => custom)
    expect(result).toBe(custom)
  })
})
