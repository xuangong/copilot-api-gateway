import { describe, expect, test } from "bun:test"
import { withImageGenerationStripped } from "~/providers/copilot/interceptors/responses/with-image-generation-stripped"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const makeInv = (enabled: boolean, tools?: unknown[]): Invocation => ({
  endpoint: "responses",
  enabledFlags: new Set(enabled ? ["transform-strip-image-generation"] : []),
  payload: {
    model: "gpt-4o",
    ...(tools !== undefined ? { tools } : {}),
  },
  headers: {},
})

describe("withImageGenerationStripped", () => {
  test("strips image_generation tool when flag enabled", async () => {
    const inv = makeInv(true, [
      { type: "image_generation" },
      { type: "function", name: "my_fn" },
    ])
    let runCalls = 0
    const result = await withImageGenerationStripped(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    expect(result).toBe(FAKE_RESPONSE)
    expect(runCalls).toBe(1)
    const tools = inv.payload.tools as unknown[]
    expect(tools).toHaveLength(1)
    expect((tools[0] as { type: string }).type).toBe("function")
  })

  test("removes tools array entirely if only image_generation remains", async () => {
    const inv = makeInv(true, [{ type: "image_generation" }])
    await withImageGenerationStripped(inv, ctx, async () => FAKE_RESPONSE)
    expect("tools" in inv.payload).toBe(false)
  })

  test("skips when flag disabled and still delegates", async () => {
    const inv = makeInv(false, [{ type: "image_generation" }])
    let runCalls = 0
    const result = await withImageGenerationStripped(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    expect(result).toBe(FAKE_RESPONSE)
    expect(runCalls).toBe(1)
    // tools should remain untouched when flag is off
    const tools = inv.payload.tools as unknown[]
    expect(tools).toHaveLength(1)
  })

  test("no-op when no tools in payload, still delegates", async () => {
    const inv = makeInv(true)
    let runCalls = 0
    const result = await withImageGenerationStripped(inv, ctx, async () => {
      runCalls++
      return FAKE_RESPONSE
    })
    expect(result).toBe(FAKE_RESPONSE)
    expect(runCalls).toBe(1)
  })

  test("delegates terminal response unchanged", async () => {
    const inv = makeInv(true, [{ type: "image_generation" }])
    const custom = new Response("custom-body", { status: 201 })
    const result = await withImageGenerationStripped(inv, ctx, async () => custom)
    expect(result).toBe(custom)
    expect(result.status).toBe(201)
  })
})
