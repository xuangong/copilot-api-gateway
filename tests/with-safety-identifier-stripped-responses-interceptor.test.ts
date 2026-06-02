import { describe, expect, test } from "bun:test"
import { withSafetyIdentifierStripped } from "~/providers/copilot/interceptors/responses/with-safety-identifier-stripped"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const makeInv = (
  enabled: boolean,
  sourceApi?: "messages" | "chat_completions" | "responses",
  safetyIdentifier?: string,
): Invocation => ({
  endpoint: "responses",
  enabledFlags: new Set(enabled ? ["transform-strip-safety-identifier"] : []),
  sourceApi,
  payload: {
    model: "gpt-4o",
    ...(safetyIdentifier !== undefined ? { safety_identifier: safetyIdentifier } : {}),
  },
  headers: {},
})

describe("withSafetyIdentifierStripped", () => {
  test("strips safety_identifier when flag on and sourceApi is messages", async () => {
    const inv = makeInv(true, "messages", "some-identifier")
    let runCalls = 0
    const result = await withSafetyIdentifierStripped(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    expect(result).toBe(FAKE_RESPONSE)
    expect(runCalls).toBe(1)
    expect("safety_identifier" in inv.payload).toBe(false)
  })

  test("strips safety_identifier when flag on and sourceApi is chat_completions", async () => {
    const inv = makeInv(true, "chat_completions", "some-identifier")
    await withSafetyIdentifierStripped(inv, ctx, async () => FAKE_RESPONSE)
    expect("safety_identifier" in inv.payload).toBe(false)
  })

  test("preserves safety_identifier when sourceApi is responses (native Responses caller)", async () => {
    const inv = makeInv(true, "responses", "some-identifier")
    await withSafetyIdentifierStripped(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.payload.safety_identifier).toBe("some-identifier")
  })

  test("preserves safety_identifier when sourceApi is undefined (treated as responses)", async () => {
    const inv = makeInv(true, undefined, "some-identifier")
    await withSafetyIdentifierStripped(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.payload.safety_identifier).toBe("some-identifier")
  })

  test("skips when flag disabled even if sourceApi is messages", async () => {
    const inv = makeInv(false, "messages", "some-identifier")
    let runCalls = 0
    const result = await withSafetyIdentifierStripped(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    expect(result).toBe(FAKE_RESPONSE)
    expect(runCalls).toBe(1)
    expect(inv.payload.safety_identifier).toBe("some-identifier")
  })

  test("delegates terminal response unchanged", async () => {
    const inv = makeInv(true, "messages", "some-identifier")
    const custom = new Response("custom-body", { status: 201 })
    const result = await withSafetyIdentifierStripped(inv, ctx, async () => custom)
    expect(result).toBe(custom)
    expect(result.status).toBe(201)
  })
})
