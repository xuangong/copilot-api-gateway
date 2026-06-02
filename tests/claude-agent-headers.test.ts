import { describe, expect, test } from "bun:test"

import { parseUserIdMetadata } from "~/transforms/detect-claude-code-metadata"
import { setClaudeAgentHeaders } from "~/transforms/set-claude-agent-headers"
import type { AnthropicMessagesPayload } from "~/transforms"

const CLAUDE_AGENT_USER_AGENT = "vscode_claude_code/2.1.112 (external, sdk-ts, agent-sdk/0.2.112)"

describe("parseUserIdMetadata", () => {
  test("undefined / empty → both null", () => {
    expect(parseUserIdMetadata(undefined)).toEqual({ safetyIdentifier: null, sessionId: null })
    expect(parseUserIdMetadata("")).toEqual({ safetyIdentifier: null, sessionId: null })
  })

  test("legacy textual form parses both halves", () => {
    expect(parseUserIdMetadata("user_acct-abc_account__session_sess-xyz")).toEqual({
      safetyIdentifier: "acct-abc",
      sessionId: "sess-xyz",
    })
  })

  test("modern JSON form with device_id + session_id", () => {
    expect(parseUserIdMetadata(JSON.stringify({ device_id: "dev-1", session_id: "sess-2" }))).toEqual({
      safetyIdentifier: "dev-1",
      sessionId: "sess-2",
    })
  })

  test("falls back to account_uuid when device_id missing", () => {
    expect(parseUserIdMetadata(JSON.stringify({ account_uuid: "acct-2", session_id: "sess-3" }))).toEqual({
      safetyIdentifier: "acct-2",
      sessionId: "sess-3",
    })
  })

  test("invalid JSON returns nulls", () => {
    expect(parseUserIdMetadata("{not json")).toEqual({ safetyIdentifier: null, sessionId: null })
  })
})

const mkPayload = (userId: string | undefined, model = "claude-sonnet-4-6"): AnthropicMessagesPayload =>
  ({
    model,
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    metadata: userId === undefined ? undefined : { user_id: userId },
  }) as unknown as AnthropicMessagesPayload

describe("setClaudeAgentHeaders", () => {
  test("sets agent headers on legacy fingerprint", () => {
    const headers: Record<string, string> = {}
    expect(setClaudeAgentHeaders(mkPayload("user_a_account__session_s"), headers)).toBe(true)
    expect(headers["x-interaction-type"]).toBe("messages-proxy")
    expect(headers["openai-intent"]).toBe("messages-proxy")
    expect(headers["user-agent"]).toBe(CLAUDE_AGENT_USER_AGENT)
    expect(headers["copilot-integration-id"]).toBe("")
  })

  test("sets agent headers on JSON fingerprint", () => {
    const headers: Record<string, string> = {}
    expect(setClaudeAgentHeaders(
      mkPayload(JSON.stringify({ device_id: "d1", session_id: "s1" })),
      headers,
    )).toBe(true)
    expect(headers["user-agent"]).toBe(CLAUDE_AGENT_USER_AGENT)
  })

  test("no-op when session_id missing", () => {
    const headers: Record<string, string> = {}
    expect(setClaudeAgentHeaders(mkPayload(JSON.stringify({ device_id: "d1" })), headers)).toBe(false)
    expect("user-agent" in headers).toBe(false)
  })

  test("no-op when metadata absent", () => {
    const headers: Record<string, string> = {}
    expect(setClaudeAgentHeaders(mkPayload(undefined), headers)).toBe(false)
    expect("user-agent" in headers).toBe(false)
  })

  test("skipped on claude-opus-4-8 even with full fingerprint", () => {
    const headers: Record<string, string> = {}
    expect(setClaudeAgentHeaders(
      mkPayload(JSON.stringify({ device_id: "d", session_id: "s" }), "claude-opus-4-8"),
      headers,
    )).toBe(false)
    expect("user-agent" in headers).toBe(false)
  })
})
