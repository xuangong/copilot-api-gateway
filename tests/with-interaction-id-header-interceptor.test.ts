import { describe, expect, test } from "bun:test"
import { withInteractionIdHeader } from "~/providers/copilot/interceptors/messages/with-interaction-id-header"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const makeInv = (enabled: boolean, userId?: string): Invocation => ({
  endpoint: "messages",
  enabledFlags: new Set(enabled ? ["transform-set-interaction-id-header"] : []),
  payload: {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    ...(userId !== undefined ? { metadata: { user_id: userId } } : {}),
  },
  headers: {},
})

describe("withInteractionIdHeader", () => {
  test("sets x-interaction-id as UUID v4 when flag on and metadata.user_id is parseable", async () => {
    const inv = makeInv(true, JSON.stringify({ session_id: "sess-test-123" }))
    await withInteractionIdHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-interaction-id"]).toMatch(UUID_V4_RE)
  })

  test("skips when flag off", async () => {
    const inv = makeInv(false, JSON.stringify({ session_id: "sess-test-123" }))
    await withInteractionIdHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect("x-interaction-id" in inv.headers).toBe(false)
  })

  test("no header when metadata.user_id is absent even if flag on", async () => {
    const inv = makeInv(true, undefined)
    await withInteractionIdHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect("x-interaction-id" in inv.headers).toBe(false)
  })

  test("delegates terminal response unchanged", async () => {
    const custom = new Response("c", { status: 202 })
    const result = await withInteractionIdHeader(
      makeInv(true, "user_a_account__session_s"),
      ctx,
      async () => custom,
    )
    expect(result).toBe(custom)
  })
})
