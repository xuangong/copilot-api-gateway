import { describe, expect, test } from "bun:test"
import { withClaudeAgentHeaders } from "~/providers/copilot/interceptors/messages/with-claude-agent-headers"
import type { Invocation, RequestContext } from "~/providers/interceptor"

const ctx: RequestContext = { requestStartedAt: 0 }
const FAKE_RESPONSE = new Response("ok")

const CLAUDE_AGENT_USER_AGENT = "vscode_claude_code/2.1.112 (external, sdk-ts, agent-sdk/0.2.112)"

/** Build an invocation carrying a metadata.user_id with both halves. */
const makeInv = (userId?: string): Invocation => ({
  endpoint: "messages",
  enabledFlags: new Set(),
  payload: {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    ...(userId !== undefined ? { metadata: { user_id: userId } } : {}),
  },
  headers: {},
})

describe("withClaudeAgentHeaders", () => {
  test("sets agent headers when payload carries full Claude Code fingerprint", async () => {
    const inv = makeInv("user_acct-abc_account__session_sess-xyz")
    await withClaudeAgentHeaders(inv, ctx, async () => FAKE_RESPONSE)
    expect(inv.headers["x-interaction-type"]).toBe("messages-proxy")
    expect(inv.headers["openai-intent"]).toBe("messages-proxy")
    expect(inv.headers["user-agent"]).toBe(CLAUDE_AGENT_USER_AGENT)
    expect(inv.headers["copilot-integration-id"]).toBe("")
  })

  test("no-op when metadata.user_id is absent", async () => {
    const inv = makeInv(undefined)
    await withClaudeAgentHeaders(inv, ctx, async () => FAKE_RESPONSE)
    expect("user-agent" in inv.headers).toBe(false)
    expect("x-interaction-type" in inv.headers).toBe(false)
  })

  test("delegates terminal response unchanged", async () => {
    const custom = new Response("c", { status: 202 })
    const result = await withClaudeAgentHeaders(makeInv("user_a_account__session_s"), ctx, async () => custom)
    expect(result).toBe(custom)
  })
})
