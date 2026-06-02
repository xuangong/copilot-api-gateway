import { describe, expect, test } from "bun:test"
import { withInitiatorHeader } from "~/providers/copilot/interceptors/shared/with-initiator-header"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const makeInv = (
  endpoint: Invocation["endpoint"],
  payload: Record<string, unknown>,
  enabled = true,
): Invocation => ({
  endpoint,
  enabledFlags: new Set(enabled ? ["transform-set-initiator-header"] : []),
  payload,
  headers: {},
})

describe("withInitiatorHeader", () => {
  test("skips when flag disabled", async () => {
    const inv = makeInv("messages", { messages: [{ role: "user", content: "hi" }] }, false)
    await withInitiatorHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-initiator"]).toBeUndefined()
  })

  test("messages: classifies last message → x-initiator", async () => {
    const inv = makeInv("messages", { messages: [{ role: "user", content: "hi" }] })
    await withInitiatorHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-initiator"]).toBe("user")
  })

  test("messages_count_tokens uses same classifier as messages", async () => {
    const inv = makeInv("messages_count_tokens", { messages: [{ role: "user", content: "hi" }] })
    await withInitiatorHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-initiator"]).toBe("user")
  })

  test("chat_completions: classifies via messages role", async () => {
    const inv = makeInv("chat_completions", { messages: [{ role: "user", content: "hi" }] })
    await withInitiatorHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-initiator"]).toBe("user")
  })

  test("deletes pre-existing X-Initiator to avoid duplicate casing", async () => {
    const inv = makeInv("messages", { messages: [{ role: "user", content: "hi" }] })
    inv.headers["X-Initiator"] = "agent"
    await withInitiatorHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["X-Initiator"]).toBeUndefined()
    expect(inv.headers["x-initiator"]).toBe("user")
  })

  test("embeddings: no-op (no conversation semantics)", async () => {
    const inv = makeInv("embeddings", { input: "hi" })
    await withInitiatorHeader(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-initiator"]).toBeUndefined()
  })
})
