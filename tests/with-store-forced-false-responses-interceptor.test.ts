import { describe, expect, test } from "bun:test"
import { withStoreForcedFalse } from "~/providers/copilot/interceptors/responses/with-store-forced-false"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const makeInv = (enabled: boolean, store?: boolean): Invocation => ({
  endpoint: "responses",
  enabledFlags: new Set(enabled ? ["transform-force-store-false"] : []),
  payload: {
    model: "gpt-4o",
    ...(store !== undefined ? { store: store } : {}),
  },
  headers: {},
})

describe("withStoreForcedFalse", () => {
  test("sets store to false when flag enabled and store is true", async () => {
    const inv = makeInv(true, true)
    let runCalls = 0
    const result = await withStoreForcedFalse(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    expect(result).toBe(FAKE_RESPONSE)
    expect(inv.payload.store).toBe(false)
    expect(runCalls).toBe(1)
  })

  test("sets store to false when flag enabled and store is undefined", async () => {
    const inv = makeInv(true)
    let runCalls = 0
    const result = await withStoreForcedFalse(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    expect(result).toBe(FAKE_RESPONSE)
    expect(runCalls).toBe(1)
  })

  test("skips when flag disabled and still delegates", async () => {
    const inv = makeInv(false, true)
    let runCalls = 0
    const result = await withStoreForcedFalse(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    expect(result).toBe(FAKE_RESPONSE)
    // store should remain true when flag is off
    expect(inv.payload.store).toBe(true)
    expect(runCalls).toBe(1)
  })

  test("delegates terminal response unchanged", async () => {
    const inv = makeInv(true, true)
    const custom = new Response("custom-body", { status: 201 })
    const result = await withStoreForcedFalse(inv, ctx, async () => custom)
    expect(result).toBe(custom)
    expect(result.status).toBe(201)
  })
})
