// tests/with-variant-and-beta-filtering-interceptor.test.ts
import { describe, expect, test } from "bun:test"
import { createVariantAndBetaFilteringInterceptor } from "~/providers/copilot/interceptors/shared/with-variant-and-beta-filtering"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const makeInv = (
  endpoint: "messages" | "chat_completions" | "responses" | "messages_count_tokens",
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Invocation => ({
  endpoint,
  enabledFlags: new Set(),
  payload,
  headers,
})

describe("withVariantAndBetaFiltering", () => {
  test("no-op when endpoint is embeddings (skipped at registry level — interceptor not registered)", async () => {
    // Sanity: the factory itself doesn't gate on endpoint — gating happens via
    // omitting it from the embeddings array. Just verifies the factory shape.
    const itc = createVariantAndBetaFilteringInterceptor("", "individual")
    const inv = makeInv("messages", { model: "claude-opus-4.7" })
    const result = await itc(inv, ctx, async () => FAKE_RESPONSE)
    expect(result).toBe(FAKE_RESPONSE)
  })

  test("composite id claude-opus-4.7-xhigh-1m parsed: model normalized, effort injected, beta merged", async () => {
    const itc = createVariantAndBetaFilteringInterceptor("", "individual")
    const inv = makeInv(
      "messages",
      { model: "claude-opus-4.7-xhigh-1m" },
      { "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
    )
    await itc(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.payload.model).toBe("claude-opus-4.7")
    const oc = inv.payload.output_config as { effort?: string } | undefined
    expect(oc?.effort).toBe("xhigh")
    expect(inv.headers["anthropic-beta"]).toContain("context-1m-2025-08-07")
  })

  test("x-copilot-reasoning-effort header consumed and injected into payload field per endpoint", async () => {
    const itc = createVariantAndBetaFilteringInterceptor("", "individual")
    const inv = makeInv(
      "chat_completions",
      { model: "gpt-5" },
      { "x-copilot-reasoning-effort": "high" },
    )
    await itc(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-copilot-reasoning-effort"]).toBeUndefined()
    expect((inv.payload as { reasoning_effort?: string }).reasoning_effort).toBe("high")
  })

  test("anthropic-beta filtered through Copilot allowlist", async () => {
    const itc = createVariantAndBetaFilteringInterceptor("", "individual")
    const inv = makeInv(
      "messages",
      { model: "claude-sonnet-4-6" },
      { "anthropic-beta": "context-management-2025-06-27,fine-grained-tool-streaming-2025-05-14" },
    )
    await itc(inv, ctx, async () => FAKE_RESPONSE)
    // context-management is stripped (not in allowlist); fine-grained-tool-streaming stays
    expect(inv.headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14")
  })

  test("delegates to terminal and returns its response", async () => {
    const itc = createVariantAndBetaFilteringInterceptor("", "individual")
    const inv = makeInv("messages", { model: "claude-opus-4.7" })
    const custom = new Response("custom", { status: 201 })
    const result = await itc(inv, ctx, async () => custom)
    expect(result).toBe(custom)
    expect(result.status).toBe(201)
  })
})
