import { describe, expect, test } from "bun:test"
import { withStructuredOutputFormatStripped } from "~/providers/copilot/interceptors/messages/with-structured-output-format-stripped"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const makeInv = (enabled: boolean, hasFormat = true): Invocation => ({
  endpoint: "messages",
  enabledFlags: new Set(enabled ? ["transform-strip-structured-output-format"] : []),
  payload: {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    ...(hasFormat
      ? { output_config: { format: { type: "object", properties: {} } } }
      : {}),
  },
  headers: {},
})

describe("withStructuredOutputFormatStripped", () => {
  test("strips output_config.format when flag on", async () => {
    const inv = makeInv(true)
    await withStructuredOutputFormatStripped(inv, ctx, async () => FAKE_RESPONSE)
    const cfg = inv.payload.output_config as Record<string, unknown> | undefined
    // format should be removed; empty container should also be gone
    expect(cfg).toBeUndefined()
  })

  test("skips when flag off", async () => {
    const inv = makeInv(false)
    await withStructuredOutputFormatStripped(inv, ctx, async () => FAKE_RESPONSE)
    const cfg = inv.payload.output_config as Record<string, unknown> | undefined
    expect(cfg?.["format"]).toBeDefined()
  })

  test("no-op when payload has no output_config.format", async () => {
    const inv = makeInv(true, false)
    // Should not throw; output_config is absent entirely
    await withStructuredOutputFormatStripped(inv, ctx, async () => FAKE_RESPONSE)
    expect("output_config" in inv.payload).toBe(false)
  })

  test("delegates terminal response unchanged", async () => {
    const custom = new Response("c", { status: 202 })
    const result = await withStructuredOutputFormatStripped(makeInv(true), ctx, async () => custom)
    expect(result).toBe(custom)
  })
})
