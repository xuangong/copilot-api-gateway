import { describe, expect, test } from "bun:test"
import { withChatCompletionsVisionHeader } from "~/providers/copilot/interceptors/chat-completions/with-vision-header"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const IMG_PART = {
  type: "image_url",
  image_url: { url: "data:image/png;base64,AAAA" },
}

const makeInv = (enabled: boolean, withImage = true): Invocation => ({
  endpoint: "chat_completions",
  enabledFlags: new Set(enabled ? ["transform-vision-header"] : []),
  payload: {
    model: "gpt-5",
    messages: withImage
      ? [{ role: "user", content: [IMG_PART, { type: "text", text: "describe" }] }]
      : [{ role: "user", content: "hi" }],
  },
  headers: {},
})

describe("withChatCompletionsVisionHeader", () => {
  test("sets copilot-vision-request when flag on and image_url present", async () => {
    const inv = makeInv(true)
    await withChatCompletionsVisionHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["copilot-vision-request"]).toBe("true")
  })

  test("skips when flag off", async () => {
    const inv = makeInv(false)
    await withChatCompletionsVisionHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect("copilot-vision-request" in inv.headers).toBe(false)
  })

  test("no header when flag on but no images in payload", async () => {
    const inv = makeInv(true, false)
    await withChatCompletionsVisionHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect("copilot-vision-request" in inv.headers).toBe(false)
  })

  test("delegates terminal response unchanged", async () => {
    const custom = new Response("c", { status: 202 })
    const result = await withChatCompletionsVisionHeader(makeInv(true), ctx, async () => custom)
    expect(result).toBe(custom)
  })
})
