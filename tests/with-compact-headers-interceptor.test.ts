import { describe, expect, test } from "bun:test"
import { withCompactHeaders } from "~/providers/copilot/interceptors/messages/with-compact-headers"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const AUTO_CONTINUE_TEXT =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation."

const COMPACT_LAST_MESSAGE_TEXT =
  "Your task is to create a detailed summary of the conversation so far.\n\n"
  + "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n"
  + "Pending Tasks:\n- finish refactor\n\nCurrent Work:\n- reviewing diff"

const makeInv = (lastMessage: string): Invocation => ({
  endpoint: "messages",
  enabledFlags: new Set(),
  payload: {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: lastMessage }],
  },
  headers: {},
})

describe("withCompactHeaders", () => {
  test("sets conversation-compaction headers for compact-summary payload", async () => {
    const inv = makeInv(COMPACT_LAST_MESSAGE_TEXT)
    await withCompactHeaders(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-initiator"]).toBe("agent")
    expect(inv.headers["x-interaction-type"]).toBe("conversation-compaction")
  })

  test("sets x-initiator: agent for auto-continue payload (no x-interaction-type)", async () => {
    const inv = makeInv(AUTO_CONTINUE_TEXT)
    await withCompactHeaders(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-initiator"]).toBe("agent")
    expect("x-interaction-type" in inv.headers).toBe(false)
  })

  test("no-op for ordinary user message", async () => {
    const inv = makeInv("hello there")
    await withCompactHeaders(inv, ctx, async () => FAKE_RESPONSE)
    expect("x-initiator" in inv.headers).toBe(false)
    expect("x-interaction-type" in inv.headers).toBe(false)
  })

  test("delegates terminal response unchanged", async () => {
    const custom = new Response("c", { status: 202 })
    const result = await withCompactHeaders(makeInv(COMPACT_LAST_MESSAGE_TEXT), ctx, async () => custom)
    expect(result).toBe(custom)
  })
})
