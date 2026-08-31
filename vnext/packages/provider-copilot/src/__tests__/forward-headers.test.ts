/**
 * Outbound header merge in callCopilotAPI.
 *
 * The interesting case is the empty-string sentinel. setClaudeAgentHeaders
 * sets `copilot-integration-id: ""` meaning "drop this header", and until the
 * merge moved to Headers it was a plain object spread — which sent an empty
 * value instead of deleting anything, so the documented behaviour had never
 * actually happened. These tests exist so it cannot silently regress.
 */
import { expect, test } from "bun:test"
import { callCopilotAPI } from "../forward"
import { setClaudeAgentHeaders } from "../transforms"
import type { AnthropicMessagesPayload } from "../transforms/types"
import type { Fetcher } from "@vibe-core/upstream"

const capture = (into: { headers?: Headers }): Fetcher => async (_url, init) => {
  into.headers = new Headers(init.headers as HeadersInit)
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
}

const call = async (extraHeaders?: Record<string, string>) => {
  const seen: { headers?: Headers } = {}
  await callCopilotAPI({
    endpoint: "/v1/messages",
    payload: { model: "claude-sonnet-4.5" },
    operationName: "test",
    copilotToken: "tok",
    accountType: "individual",
    extraHeaders,
    fetcher: capture(seen),
  })
  return seen.headers!
}

test("baseline headers reach upstream unchanged when nothing overrides them", async () => {
  const headers = await call()
  expect(headers.get("copilot-integration-id")).toBe("vscode-chat")
  expect(headers.get("user-agent")).toBe("GitHubCopilotChat/0.52.0")
  expect(headers.get("editor-version")).toBe("vscode/1.124.2")
})

test("a non-empty extra header overrides the baseline value", async () => {
  const headers = await call({ "openai-intent": "something-else" })
  expect(headers.get("openai-intent")).toBe("something-else")
})

test("an empty extra header deletes it rather than sending an empty value", async () => {
  const headers = await call({ "copilot-integration-id": "" })
  expect(headers.has("copilot-integration-id")).toBe(false)
})

test("the Claude Code agent identity lands intact, integration id stripped", async () => {
  const payload = {
    model: "claude-sonnet-4.5",
    metadata: { user_id: "user_abc_account__session_xyz" },
  } as unknown as AnthropicMessagesPayload

  const extra: Record<string, string> = {}
  expect(setClaudeAgentHeaders(payload, extra)).toBe(true)

  const headers = await call(extra)
  expect(headers.get("user-agent")).toStartWith("vscode_claude_code/")
  expect(headers.get("openai-intent")).toBe("messages-proxy")
  expect(headers.get("x-interaction-type")).toBe("messages-proxy")
  expect(headers.has("copilot-integration-id")).toBe(false)
})
