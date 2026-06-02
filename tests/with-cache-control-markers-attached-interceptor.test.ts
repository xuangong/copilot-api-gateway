import { describe, expect, test } from "bun:test"
import { withCacheControlMarkersAttached } from "~/providers/copilot/interceptors/chat-completions/with-cache-control-markers-attached"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const makeInv = (enabled: boolean): Invocation => ({
  endpoint: "chat_completions",
  enabledFlags: new Set(enabled ? ["transform-attach-cache-control-markers"] : []),
  payload: {
    model: "gpt-5",
    messages: [
      { role: "system", content: "you are a helpful assistant" },
      { role: "user", content: "hi" },
    ],
  },
  headers: {},
})

describe("withCacheControlMarkersAttached", () => {
  test("attaches copilot_cache_control when flag enabled", async () => {
    const inv = makeInv(true)
    let runCalls = 0
    await withCacheControlMarkersAttached(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    const messages = inv.payload.messages as Array<Record<string, unknown>>
    const marked = messages.some((m) => "copilot_cache_control" in m)
    expect(marked).toBe(true)
    expect(runCalls).toBe(1)
  })

  test("skips when flag disabled but still delegates", async () => {
    const inv = makeInv(false)
    let runCalls = 0
    await withCacheControlMarkersAttached(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    const messages = inv.payload.messages as Array<Record<string, unknown>>
    const marked = messages.some((m) => "copilot_cache_control" in m)
    expect(marked).toBe(false)
    expect(runCalls).toBe(1)
  })

  test("delegates terminal response unchanged", async () => {
    const custom = new Response("c", { status: 202 })
    const result = await withCacheControlMarkersAttached(makeInv(true), ctx, async () => custom)
    expect(result).toBe(custom)
    expect(result.status).toBe(202)
  })
})
